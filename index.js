//----------------------------
// index.js
// author: Mohan Chinnappan
//----------------------------

// This script is a command-line utility for Salesforce developers to run SOQL queries, execute anonymous Apex code, call custom REST APIs, track changes in Salesforce, and perform Bulk API 2.0 operations.
// It uses the jsforce library to connect to Salesforce and perform these operations.
// It also uses the csv-writer library to export query results to CSV files and csv-parse for reading CSV files for Bulk API.
// The script prompts the user for input and provides options to execute different tasks.

const { exec } = require('child_process');
const util = require('util');
const jsforce = require('jsforce');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');
const { parse } = require('csv-parse');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');

// Constants
const LAST_USERNAME_FILE = 'last_username.txt';

// Promisify exec to use async/await
const execPromise = util.promisify(exec);

// Create a readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Function to prompt user for input
function promptUser(question) {
    return new Promise((resolve) => {
        rl.question(chalk.green(question), (answer) => {
            resolve(answer);
        });
    });
}

// Function to get Salesforce credentials using SFDX CLI
async function getSalesforceCredentials(username) {
    try {
        const { stdout } = await execPromise(`sf org display -u ${username} --json`);
        const result = JSON.parse(stdout);
        const accessToken = result.result.accessToken;
        const instanceUrl = result.result.instanceUrl;
        return { accessToken, instanceUrl };
    } catch (error) {
        console.error(chalk.red('Error retrieving Salesforce credentials:', error.message));
        throw error;
    }
}

// Function to initialize jsforce connection
async function initializeConnection(accessToken, instanceUrl) {
    const conn = new jsforce.Connection({
        instanceUrl: instanceUrl,
        accessToken: accessToken
    });
    return conn;
}

// Function to run SOQL query
async function runSOQLQuery(conn) {
    const query = await promptUser('Enter your SOQL query (e.g., SELECT Id, Name FROM Account LIMIT 10): ');
    try {
        let result = await conn.query(query);
        let allRecords = result.records || [];

        while (!result.done && result.nextRecordsUrl) {
            console.log(chalk.yellow(`Fetching more records... (${allRecords.length} of ${result.totalSize} retrieved)`));
            result = await conn.queryMore(result.nextRecordsUrl);
            allRecords = allRecords.concat(result.records || []);
        }

        console.log(chalk.blue('\n=== Query Results (JSON) ==='));
        console.log(JSON.stringify(allRecords, null, 2));

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes') {
            const headers = Object.keys(allRecords[0] || {})
                .filter(key => key !== 'attributes')
                .map(key => ({ id: key, title: key }));

            const csvWriter = createObjectCsvWriter({
                path: 'query_results.csv',
                header: headers
            });

            await csvWriter.writeRecords(allRecords);
            console.log(chalk.magenta('Results exported to query_results.csv'));
        }
    } catch (error) {
        console.error(chalk.red('Error executing SOQL query:', error.message));
    }
}

// Function to run anonymous Apex code
async function runApex(conn) {
    const apexCode = await promptUser('Enter your anonymous Apex code (end with Ctrl+D on a new line):\n');
    try {
        const result = await conn.tooling.executeAnonymous(apexCode);
        console.log(chalk.blue('\n=== Apex Execution Result (JSON) ==='));
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(chalk.red('Error executing Apex:', error.message));
    }
}

// Function to call a custom REST API URL
async function callRestApi(conn) {
    console.log(chalk.yellow('Select HTTP method:'));
    console.log(chalk.yellow('1. GET'));
    console.log(chalk.yellow('2. POST'));
    console.log(chalk.yellow('3. PATCH'));
    console.log(chalk.yellow('4. DELETE'));
    const methodChoice = await promptUser('Enter the method number (1-4): ');

    let method;
    switch (methodChoice) {
        case '1':
            method = 'GET';
            break;
        case '2':
            method = 'POST';
            break;
        case '3':
            method = 'PATCH';
            break;
        case '4':
            method = 'DELETE';
            break;
        default:
            console.log(chalk.red('Invalid method selected. Defaulting to GET.'));
            method = 'GET';
    }

    const relativeUrl = await promptUser('Enter the REST API URL (e.g., /services/data/v59.0/sobjects/Account/describe): ');

    let payload = null;
    if (method === 'POST' || method === 'PATCH') {
        const filePath = await promptUser('Enter the path to the JSON payload file (e.g., payload.json): ');
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            payload = JSON.parse(fileContent);
            console.log(chalk.blue('Payload loaded successfully:'));
            console.log(JSON.stringify(payload, null, 2));
        } catch (error) {
            console.error(chalk.red('Error reading or parsing JSON file:', error.message));
            return;
        }
    }

    try {
        const headers = {
            'Authorization': `Bearer ${conn.accessToken}`,
            'Content-Type': 'application/json'
        };

        let response;
        if (method === 'GET') {
            response = await axios.get(`${conn.instanceUrl}${relativeUrl}`, { headers });
        } else if (method === 'POST') {
            response = await axios.post(`${conn.instanceUrl}${relativeUrl}`, payload, { headers });
        } else if (method === 'PATCH') {
            response = await axios.patch(`${conn.instanceUrl}${relativeUrl}`, payload, { headers });
        } else if (method === 'DELETE') {
            response = await axios.delete(`${conn.instanceUrl}${relativeUrl}`, { headers });
        }

        let allData = [];
        let responseData = response.data;

        if (method === 'GET') {
            const getRecordsArray = (data) => {
                for (const key in data) {
                    if (Array.isArray(data[key])) {
                        return { key, records: data[key] };
                    }
                }
                return { key: null, records: [] };
            };

            let { key: recordsKey, records } = getRecordsArray(responseData);
            if ((responseData.nextPageUrl || (responseData.nextRecordsUrl && !responseData.done)) && recordsKey) {
                allData = records || [];

                while (responseData.nextPageUrl || (responseData.nextRecordsUrl && !responseData.done)) {
                    const nextUrl = responseData.nextPageUrl || responseData.nextRecordsUrl;
                    console.log(chalk.yellow(`Fetching more records... (${allData.length}${responseData.totalSize ? ` of ${responseData.totalSize}` : ''} retrieved)`));
                    response = await axios.get(`${conn.instanceUrl}${nextUrl}`, { headers });
                    responseData = response.data;
                    records = responseData[recordsKey] || [];
                    allData = allData.concat(records);
                }
            } else {
                allData = Array.isArray(responseData) ? responseData : records.length > 0 ? records : [responseData];
            }
        } else {
            allData = responseData;
        }

        console.log(chalk.blue('\n=== REST API Response (JSON) ==='));
        console.log(JSON.stringify(allData, null, 2));

        const exportToJson = await promptUser('Export response to JSON file? (yes/no): ');
        if (exportToJson.toLowerCase() === 'yes') {
            await fs.writeFile('rest_api_response.json', JSON.stringify(allData, null, 2));
            console.log(chalk.magenta('Response exported to rest_api_response.json'));
        }

        if (method === 'GET' && Array.isArray(allData)) {
            const outputFormat = await promptUser('Export to CSV? (yes/no): ');
            if (outputFormat.toLowerCase() === 'yes') {
                const csvWriter = createObjectCsvWriter({
                    path: 'rest_api_results.csv',
                    header: Object.keys(allData[0] || {})
                        .filter(key => key !== 'attributes')
                        .map(key => ({ id: key, title: key }))
                });
                await csvWriter.writeRecords(allData);
                console.log(chalk.magenta('Results exported to rest_api_results.csv'));
            }
        }
    } catch (error) {
        console.error(chalk.red('Error calling REST API:', error.message));
    }
}

// Function to get user ID from username
async function getUserIdFromUsername(conn, username) {
    try {
        const result = await conn.query(`SELECT Id FROM User WHERE Username = '${username}' LIMIT 1`);
        if (result.records.length === 0) {
            throw new Error(`User with username "${username}" not found.`);
        }
        return result.records[0].Id;
    } catch (error) {
        console.error(chalk.red('Error retrieving user ID:', error.message));
        throw error;
    }
}

// Function to track changes in SourceMember
async function trackChanges(conn) {
    console.log(chalk.yellow('Note: Change tracking only works in sandboxes and scratch orgs, not in production orgs.'));
    const sinceDate = await promptUser('Enter the date to track changes since (YYYY-MM-DD, e.g., 2025-04-01), or press Enter for all changes: ');
    const lastModifiedByUsername = await promptUser('Enter the username of the last modified by user (e.g., user@example.org), or press Enter to skip: ');

    let query = `
        SELECT
            Id,
            LastModifiedBy.Name,
            MemberIdOrName,
            MemberType,
            MemberName,
            RevisionNum,
            RevisionCounter,
            IsNameObsolete,
            LastModifiedById,
            IsNewMember,
            ChangedBy
        FROM SourceMember
    `;
    const conditions = [];

    if (sinceDate) {
        conditions.push(`LastModifiedDate >= ${sinceDate}T00:00:00Z`);
    }

    let lastModifiedById = null;
    if (lastModifiedByUsername) {
        try {
            lastModifiedById = await getUserIdFromUsername(conn, lastModifiedByUsername);
            conditions.push(`LastModifiedById = '${lastModifiedById}'`);
        } catch (error) {
            return;
        }
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY LastModifiedDate DESC';

    try {
        let result = await conn.tooling.query(query);
        let allRecords = result.records || [];

        while (!result.done && result.nextRecordsUrl) {
            console.log(chalk.yellow(`Fetching more records... (${allRecords.length} of ${result.totalSize} retrieved)`));
            result = await conn.requestGet(result.nextRecordsUrl);
            allRecords = allRecords.concat(result.records || []);
        }

        if (allRecords.length === 0) {
            console.log(chalk.yellow('No changes found matching the criteria.'));
            return;
        }

        console.log(chalk.blue('\n=== Tracked Changes (JSON) ==='));
        console.log(JSON.stringify(allRecords, null, 2));

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes') {
            const csvWriter = createObjectCsvWriter({
                path: 'tracked_changes.csv',
                header: [
                    { id: 'Id', title: 'Id' },
                    { id: 'LastModifiedBy.Name', title: 'Last Modified By Name' },
                    { id: 'MemberIdOrName', title: 'Member Id or Name' },
                    { id: 'MemberType', title: 'Member Type' },
                    { id: 'MemberName', title: 'Member Name' },
                    { id: 'RevisionNum', title: 'Revision Number' },
                    { id: 'RevisionCounter', title: 'Revision Counter' },
                    { id: 'IsNameObsolete', title: 'Is Name Obsolete' },
                    { id: 'LastModifiedById', title: 'Last Modified By Id' },
                    { id: 'IsNewMember', title: 'Is New Member' },
                    { id: 'ChangedBy', title: 'Changed By' }
                ]
            });

            const flattenedRecords = allRecords.map(record => ({
                ...record,
                'LastModifiedBy.Name': record.LastModifiedBy ? record.LastModifiedBy.Name : 'N/A'
            }));

            await csvWriter.writeRecords(flattenedRecords);
            console.log(chalk.magenta('Results exported to tracked_changes.csv'));
        }

        const generatePackage = await promptUser('Generate package.xml for these changes? (yes/no): ');
        if (generatePackage.toLowerCase() === 'yes') {
            const packageXml = generatePackageXml(allRecords);
            await fs.writeFile('package.xml', packageXml);
            console.log(chalk.green('package.xml generated successfully.'));
        }
    } catch (error) {
        console.error(chalk.red('Error tracking changes:', error.message));
    }
}

// Function to generate package.xml based on tracked changes
function generatePackageXml(records) {
    const typesMap = new Map();
    records.forEach(record => {
        if (!typesMap.has(record.MemberType)) {
            typesMap.set(record.MemberType, []);
        }
        typesMap.get(record.MemberType).push(record.MemberName);
    });

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';

    for (const [type, members] of typesMap) {
        xml += '    <types>\n';
        members.forEach(member => {
            xml += `        <members>${member}</members>\n`;
        });
        xml += `        <name>${type}</name>\n`;
        xml += '    </types>\n';
    }

    xml += '    <version>59.0</version>\n';
    xml += '</Package>';
    return xml;
}

// Function to run Bulk API 2.0 job

// Function to run Bulk API 2.0 job using REST API
async function runBulkApiJob(conn) {
    try {
        // Test connection with a simple query
        try {
            await conn.query('SELECT Id FROM Account LIMIT 1');
            console.log(chalk.green('Connection verified successfully.'));
        } catch (error) {
            console.error(chalk.red('Connection test failed:', error.message));
            return;
        }

        // Prompt for Salesforce object and operation
        const sObject = await promptUser('Enter the Salesforce object (e.g., Account, Contact): ');

        // Validate object name
        try {
            await conn.describe(sObject);
            console.log(chalk.green(`Object ${sObject} is valid.`));
        } catch (error) {
            console.error(chalk.red(`Invalid or inaccessible object "${sObject}":`, error.message));
            return;
        }

        console.log(chalk.yellow('Select Bulk API operation:'));
        console.log(chalk.yellow('1. Insert'));
        console.log(chalk.yellow('2. Update'));
        console.log(chalk.yellow('3. Upsert'));
        console.log(chalk.yellow('4. Delete'));
        const operationChoice = await promptUser('Enter the operation number (1-4): ');

        let operation;
        switch (operationChoice) {
            case '1':
                operation = 'insert';
                break;
            case '2':
                operation = 'update';
                break;
            case '3':
                operation = 'upsert';
                break;
            case '4':
                operation = 'delete';
                break;
            default:
                console.log(chalk.red('Invalid operation selected. Defaulting to insert.'));
                operation = 'insert';
        }

        let externalIdFieldName = null;
        if (operation === 'upsert') {
            externalIdFieldName = await promptUser('Enter the external ID field name for upsert (e.g., ExternalId__c): ');
            if (!externalIdFieldName) {
                console.error(chalk.red('External ID field name is required for upsert.'));
                return;
            }
        }

        // Prompt for CSV file
        const csvFilePath = await promptUser('Enter the path to the CSV file (e.g., data.csv): ');
        let csvContent;
        try {
            csvContent = await fs.readFile(csvFilePath, 'utf8');
            if (!csvContent.trim()) {
                throw new Error('CSV file is empty.');
            }
        } catch (error) {
            console.error(chalk.red('Error reading CSV file:', error.message));
            return;
        }

        // Create Bulk API 2.0 job using REST API
        let jobInfo;
        try {
            console.log(chalk.yellow('Creating job using REST API...'));
            jobInfo = await conn.requestPost('/services/data/v59.0/jobs/ingest', {
                object: sObject,
                operation: operation,
                externalIdFieldName: externalIdFieldName || undefined,
                contentType: 'CSV',
                lineEnding: 'LF'
            });
            console.log(chalk.yellow('REST jobInfo response:', JSON.stringify(jobInfo, null, 2)));
        } catch (error) {
            console.error(chalk.red('Error creating job:', error.message));
            return;
        }

        if (!jobInfo || !jobInfo.id) {
            console.error(chalk.red('Failed to create job: Invalid jobInfo response:', JSON.stringify(jobInfo || {})));
            return;
        }

        console.log(chalk.blue('\n=== Bulk API Job Created ==='));
        console.log(chalk.blue(JSON.stringify({
            id: jobInfo.id,
            object: jobInfo.object,
            operation: jobInfo.operation,
            state: jobInfo.state,
            contentType: jobInfo.contentType
        }, null, 2)));

        // Upload CSV data to the job
        try {
            console.log(chalk.yellow('Uploading CSV data using REST API...'));
            await conn.request({
                method: 'PUT',
                url: `/services/data/v59.0/jobs/ingest/${jobInfo.id}/batches`,
                body: csvContent,
                headers: {
                    'Content-Type': 'text/csv'
                }
            });
            console.log(chalk.green('CSV data uploaded successfully.'));
        } catch (error) {
            console.error(chalk.red('Error uploading CSV data:', error.message));
            return;
        }

        // Close the job to start processing
        try {
            console.log(chalk.yellow('Closing job using REST API...'));
            await conn.request({
                method: 'PATCH',
                url: `/services/data/v59.0/jobs/ingest/${jobInfo.id}`,
                body: JSON.stringify({ state: 'UploadComplete' }),
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            console.log(chalk.green('Job closed successfully.'));
        } catch (error) {
            console.error(chalk.red('Error closing job:', error.message));
            return;
        }

        // Monitor job status
        let jobStatus;
        try {
            console.log(chalk.yellow('Fetching initial job status...'));
            jobStatus = await conn.requestGet(`/services/data/v59.0/jobs/ingest/${jobInfo.id}`);
        } catch (error) {
            console.error(chalk.red('Error retrieving job status:', error.message));
            return;
        }

        console.log(chalk.yellow('Monitoring job status...'));
        while (jobStatus.state !== 'JobComplete' && jobStatus.state !== 'Failed' && jobStatus.state !== 'Aborted') {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            try {
                jobStatus = await conn.requestGet(`/services/data/v59.0/jobs/ingest/${jobInfo.id}`);
                console.log(chalk.yellow(`Job Status: ${jobStatus.state}, Records Processed: ${jobStatus.numberRecordsProcessed}, Records Failed: ${jobStatus.numberRecordsFailed}`));
            } catch (error) {
                console.error(chalk.red('Error checking job status:', error.message));
                return;
            }
        }

        console.log(chalk.blue('\n=== Final Job Status ==='));
        console.log(chalk.blue(JSON.stringify({
            id: jobStatus.id,
            state: jobStatus.state,
            numberRecordsProcessed: jobStatus.numberRecordsProcessed,
            numberRecordsFailed: jobStatus.numberRecordsFailed,
            totalProcessingTime: jobStatus.totalProcessingTime
        }, null, 2)));

        // Retrieve and export results if there are failed records or user requests results
        if (jobStatus.numberRecordsFailed > 0 || (await promptUser('Export job results to CSV? (yes/no): ')).toLowerCase() === 'yes') {
            // Fetch successful results
            try {
                console.log(chalk.yellow('Fetching successful results...'));
                const successfulResultsResponse = await conn.requestGet(`/services/data/v59.0/jobs/ingest/${jobInfo.id}/successfulResults`);
                const successfulResults = await new Promise((resolve, reject) => {
                    const records = [];
                    require('csv-parse')({ columns: true })
                        .on('data', (record) => records.push(record))
                        .on('end', () => resolve(records))
                        .on('error', (error) => reject(error))
                        .write(successfulResultsResponse);
                });
                if (successfulResults.length > 0) {
                    const csvWriter = createObjectCsvWriter({
                        path: 'bulk_api_successful_results.csv',
                        header: Object.keys(successfulResults[0]).map(key => ({ id: key, title: key }))
                    });
                    await csvWriter.writeRecords(successfulResults);
                    console.log(chalk.magenta('Successful results exported to bulk_api_successful_results.csv'));
                }
            } catch (error) {
                console.error(chalk.red('Error retrieving successful results:', error.message));
            }

            // Fetch failed results
            try {
                console.log(chalk.yellow('Fetching failed results...'));
                const failedResultsResponse = await conn.requestGet(`/services/data/v59.0/jobs/ingest/${jobInfo.id}/failedResults`);
                const failedResults = await new Promise((resolve, reject) => {
                    const records = [];
                    require('csv-parse')({ columns: true })
                        .on('data', (record) => records.push(record))
                        .on('end', () => resolve(records))
                        .on('error', (error) => reject(error))
                        .write(failedResultsResponse);
                });
                if (failedResults.length > 0) {
                    const csvWriter = createObjectCsvWriter({
                        path: 'bulk_api_failed_results.csv',
                        header: Object.keys(failedResults[0]).map(key => ({ id: key, title: key }))
                    });
                    await csvWriter.writeRecords(failedResults);
                    console.log(chalk.magenta('Failed results exported to bulk_api_failed_results.csv'));
                }
            } catch (error) {
                console.error(chalk.red('Error retrieving failed results:', error.message));
            }
        }
    } catch (error) {
        console.error(chalk.red('Error executing Bulk API job:', error.message));
    }
}

// Main menu function
async function mainMenu(conn) {
    while (true) {
        console.log(chalk.cyan.bold('\n=== SF Utils - Salesforce SOQL Query and Run Apex ==='));
        console.log(chalk.yellow('1. Run SOQL Query'));
        console.log(chalk.yellow('2. Run Anonymous Apex'));
        console.log(chalk.yellow('3. Call Custom REST API URL'));
        console.log(chalk.yellow('4. Track Changes (SourceMember)'));
        console.log(chalk.yellow('5. Run Bulk API 2.0 Job'));
        console.log(chalk.yellow('6. Exit'));
        
        const choice = await promptUser('Select an option (1-6): ');

        switch (choice) {
            case '1':
                await runSOQLQuery(conn);
                break;
            case '2':
                await runApex(conn);
                break;
            case '3':
                await callRestApi(conn);
                break;
            case '4':
                await trackChanges(conn);
                break;
            case '5':
                await runBulkApiJob(conn);
                break;
            case '6':
                console.log(chalk.green('Exiting...'));
                rl.close();
                return;
            default:
                console.log(chalk.red('Invalid option. Please try again.'));
        }
    }
}

(async () => {
    try {
        let lastUsername = '';
        try {
            lastUsername = await fs.readFile(LAST_USERNAME_FILE, 'utf8');
            lastUsername = lastUsername.trim();
        } catch (error) {
            // File doesn't exist or can't be read; proceed with empty default
        }

        const defaultPrompt = lastUsername ? ` (default: ${lastUsername})` : '';
        const username = await promptUser(`Enter your Salesforce username${defaultPrompt}: `) || lastUsername;
        if (!username) {
            throw new Error('Salesforce username is required.');
        }

        await fs.writeFile(LAST_USERNAME_FILE, username);

        const { accessToken, instanceUrl } = await getSalesforceCredentials(username);
        const conn = await initializeConnection(accessToken, instanceUrl);
        console.log(chalk.green('Successfully connected to Salesforce!'));
        await mainMenu(conn);
    } catch (error) {
        console.error(chalk.red('Failed to initialize:', error.message));
        rl.close();
    }
})();