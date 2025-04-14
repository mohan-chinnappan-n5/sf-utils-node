// lib/soql.js
const { createObjectCsvWriter } = require('csv-writer');
const chalk = require('chalk');

async function runSOQLQuery(conn, query, apiChoice, runExplainPlan = false) {
    let explainPlans = null;
    if (runExplainPlan && apiChoice === '1') {
        try {
            console.log(chalk.yellow('Running Explain Plan...'));
            const explainResult = await conn.requestGet(`/services/data/v${conn.apiVersion}/query/?explain=${encodeURIComponent(query)}`);
            explainPlans = Array.isArray(explainResult.plans) ? explainResult.plans : [explainResult];
        } catch (error) {
            console.error(chalk.red(`Error running Explain Plan: ${error.message}`));
            explainPlans = []; // Ensure empty array to continue execution
        }
    }

    const startTime = performance.now();
    let result;
    if (apiChoice === '2') {
        result = await conn.tooling.query(query);
    } else {
        result = await conn.query(query);
    }

    let allRecords = result.records || [];
    while (!result.done && result.nextRecordsUrl) {
        if (apiChoice === '2') {
            result = await conn.tooling.queryMore(result.nextRecordsUrl);
        } else {
            result = await conn.queryMore(result.nextRecordsUrl);
        }
        allRecords = allRecords.concat(result.records || []);
    }
    const executionTime = (performance.now() - startTime).toFixed(2);

    if (allRecords.length > 0) {
        const headers = Object.keys(allRecords[0])
            .filter(key => key !== 'attributes')
            .map(key => ({ id: key, title: key.replace(/([A-Z])/g, ' $1').trim() }));

        const flattenedRecords = allRecords.map(record => {
            const flatRecord = {};
            Object.keys(record).forEach(key => {
                if (key !== 'attributes') {
                    if (typeof record[key] === 'object' && record[key] && 'Name' in record[key]) {
                        flatRecord[key] = record[key].Name || 'N/A';
                    } else {
                        flatRecord[key] = record[key];
                    }
                }
            });
            return flatRecord;
        });

        const csvWriter = createObjectCsvWriter({
            path: 'query_results.csv',
            header: headers
        });
        await csvWriter.writeRecords(flattenedRecords);
    }

    return { records: allRecords, executionTime, explainPlans };
}

module.exports = { runSOQLQuery };