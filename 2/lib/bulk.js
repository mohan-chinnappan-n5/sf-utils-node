// lib/bulk.js
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs').promises;
const csvParse = require('csv-parse');
const axios = require('axios');

async function runBulkApiJob(conn, sObject, operation, externalIdFieldName, csvFilePath) {
    try {
        // Test connection
        await conn.query('SELECT Id FROM Account LIMIT 1').catch(err => {
            throw new Error(`Connection test failed: ${err.message}`);
        });

        // Validate object
        await conn.describe(sObject).catch(err => {
            throw new Error(`Invalid or inaccessible object "${sObject}": ${err.message}`);
        });

        // Read and validate CSV
        const csvContent = await fs.readFile(csvFilePath, 'utf8').catch(err => {
            throw new Error(`Error reading CSV file: ${err.message}`);
        });
        if (!csvContent.trim()) {
            throw new Error('CSV file is empty.');
        }
        // Check file size (e.g., warn if > 10MB)
        const stats = await fs.stat(csvFilePath);
        if (stats.size > 10 * 1024 * 1024) {
            console.warn('Warning: Large CSV file detected (>10MB). Upload may take time.');
        }

        const apiVersion = conn.apiVersion || '60.0';

        // Create job
        console.log('DEBUG: Creating Bulk API job...');
        const jobInfo = await conn.requestPost(`/services/data/v${apiVersion}/jobs/ingest`, {
            object: sObject,
            operation,
            externalIdFieldName: externalIdFieldName || undefined,
            contentType: 'CSV',
            lineEnding: 'LF'
        }).catch(err => {
            throw new Error(`Error creating job: ${err.message}`);
        });
        console.log('DEBUG: Job created with ID:', jobInfo.id);

        // Upload CSV
        console.log('DEBUG: Uploading CSV data...');
        await conn.request({
            method: 'PUT',
            url: `/services/data/v${apiVersion}/jobs/ingest/${jobInfo.id}/batches`,
            body: csvContent,
            headers: { 'Content-Type': 'text/csv' },
            timeout: 300000 // 5-minute timeout
        }).catch(err => {
            throw new Error(`Error uploading CSV data: ${err.message}`);
        });
        console.log('DEBUG: CSV data uploaded.');

        // Close job
        console.log('DEBUG: Closing job...');
        await conn.request({
            method: 'PATCH',
            url: `/services/data/v${apiVersion}/jobs/ingest/${jobInfo.id}`,
            body: JSON.stringify({ state: 'UploadComplete' }),
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 // 1-minute timeout
        }).catch(err => {
            throw new Error(`Error closing job: ${err.message}`);
        });
        console.log('DEBUG: Job closed.');

        // Poll job status
        console.log('DEBUG: Polling job status...');
        let jobStatus = await conn.requestGet(`/services/data/v${apiVersion}/jobs/ingest/${jobInfo.id}`).catch(err => {
            throw new Error(`Error retrieving job status: ${err.message}`);
        });
        const maxPollAttempts = 60; // 5 minutes at 5s intervals
        let pollCount = 0;
        while (jobStatus.state !== 'JobComplete' && jobStatus.state !== 'Failed' && jobStatus.state !== 'Aborted') {
            if (pollCount >= maxPollAttempts) {
                throw new Error('Job status polling timed out after 5 minutes.');
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
            jobStatus = await conn.requestGet(`/services/data/v${apiVersion}/jobs/ingest/${jobInfo.id}`).catch(err => {
                throw new Error(`Error checking job status: ${err.message}`);
            });
            console.log('DEBUG: Job status:', jobStatus.state, 'Records Processed:', jobStatus.numberRecordsProcessed);
            pollCount++;
        }
        console.log('DEBUG: Final job status:', jobStatus.state);

        // Process results
        if (jobStatus.numberRecordsProcessed > 0 || jobStatus.numberRecordsFailed > 0) {
            console.log('DEBUG: Fetching successful results...');
            let successfulResults = [];
            try {
                const successfulResultsResponse = await axios.get(
                    `${conn.instanceUrl}/services/data/v${apiVersion}/jobs/ingest/${jobInfo.id}/successfulResults`,
                    {
                        headers: {
                            'Authorization': `Bearer ${conn.accessToken}`,
                            'Content-Type': 'text/csv'
                        },
                        responseType: 'text',
                        timeout: 30000 // 30-second timeout
                    }
                );
                console.log('DEBUG: Successful results response size:', successfulResultsResponse.data.length, 'bytes');
                console.log('DEBUG: Successful results raw CSV:', successfulResultsResponse.data);
                if (successfulResultsResponse.data.trim()) {
                    successfulResults = await new Promise((resolve, reject) => {
                        const records = [];
                        const parser = csvParse.parse({ columns: true });
                        parser
                            .on('data', record => records.push(record))
                            .on('end', () => resolve(records))
                            .on('error', reject)
                            .write(successfulResultsResponse.data);
                        parser.end(); // Explicitly close the stream
                    });
                } else {
                    console.log('DEBUG: No successful results data to parse.');
                }
            } catch (err) {
                console.error('DEBUG: Failed to fetch/parse successful results:', err.message);
            }
            if (successfulResults.length > 0) {
                const csvWriter = createObjectCsvWriter({
                    path: 'bulk_api_successful_results.csv',
                    header: Object.keys(successfulResults[0]).map(key => ({ id: key, title: key }))
                });
                await csvWriter.writeRecords(successfulResults);
                console.log('DEBUG: Successful results written to bulk_api_successful_results.csv');
            } else {
                console.log('DEBUG: No successful results to write.');
            }

            console.log('DEBUG: Fetching failed results...');
            let failedResults = [];
            try {
                const failedResultsResponse = await axios.get(
                    `${conn.instanceUrl}/services/data/v${apiVersion}/jobs/ingest/${jobInfo.id}/failedResults`,
                    {
                        headers: {
                            'Authorization': `Bearer ${conn.accessToken}`,
                            'Content-Type': 'text/csv'
                        },
                        responseType: 'text',
                        timeout: 30000 // 30-second timeout
                    }
                );
                console.log('DEBUG: Failed results response size:', failedResultsResponse.data.length, 'bytes');
                console.log('DEBUG: Failed results raw CSV:', failedResultsResponse.data);
                if (failedResultsResponse.data.trim()) {
                    failedResults = await new Promise((resolve, reject) => {
                        const records = [];
                        const parser = csvParse.parse({ columns: true });
                        parser
                            .on('data', record => records.push(record))
                            .on('end', () => resolve(records))
                            .on('error', reject)
                            .write(failedResultsResponse.data);
                        parser.end(); // Explicitly close the stream
                    });
                } else {
                    console.log('DEBUG: No failed results data to parse.');
                }
            } catch (err) {
                console.error('DEBUG: Failed to fetch/parse failed results:', err.message);
            }
            if (failedResults.length > 0) {
                const csvWriter = createObjectCsvWriter({
                    path: 'bulk_api_failed_results.csv',
                    header: Object.keys(failedResults[0]).map(key => ({ id: key, title: key }))
                });
                await csvWriter.writeRecords(failedResults);
                console.log('DEBUG: Failed results written to bulk_api_failed_results.csv');
            } else {
                console.log('DEBUG: No failed results to write.');
            }
        }

        return jobStatus;
    } catch (error) {
        throw new Error(`Bulk API job failed: ${error.message}`);
    }
}

module.exports = { runBulkApiJob };