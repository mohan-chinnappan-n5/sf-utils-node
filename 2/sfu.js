#!/usr/bin/env node
// index.js
// author: Mohan Chinnappan
// CLI for Salesforce utilities using commander.js

const { Command } = require('commander');
const fs = require('fs').promises;
const chalk = require('chalk');
const {
    getSalesforceCredentials,
    initializeConnection
} = require('./lib/auth');
const { runSOQLQuery } = require('./lib/soql');
const { callRestApi } = require('./lib/rest');
const { trackChanges } = require('./lib/track');
const { runBulkApiJob } = require('./lib/bulk');
const { runApex } = require('./lib/apex');

const LAST_USERNAME_FILE = 'last_username.txt';

async function main() {
    const program = new Command();

    program
        .name('sfu')
        .description('Salesforce Utility CLI for SOQL queries, REST API, change tracking, Bulk API, and Apex execution')
        .version('1.0.0');

    // Command: sfu query
    program
        .command('query')
        .description('Run a SOQL query')
        .option('-q, --query <query>', 'SOQL query string')
        .option('-f, --file <queryfile>', 'Path to .soql file containing the query')
        .option('-t, --tooling', 'Use Tooling API')
        .option('-p, --plan', 'Run Explain Plan (Standard API only)')
        .action(async (options) => {
            if (!options.query && !options.file) {
                console.error(chalk.red('Error: Either --query or --file is required.'));
                process.exit(1);
            }
            if (options.query && options.file) {
                console.error(chalk.red('Error: Use either --query or --file, not both.'));
                process.exit(1);
            }

            let query;
            if (options.file) {
                try {
                    query = await fs.readFile(options.file, 'utf8');
                    query = query.trim();
                    if (!query) throw new Error('SOQL file is empty.');
                } catch (error) {
                    console.error(chalk.red(`Error reading SOQL file: ${error.message}`));
                    process.exit(1);
                }
            } else {
                query = options.query.trim();
            }

            try {
                const conn = await initializeConn();
                const apiChoice = options.tooling ? '2' : '1';
                const runExplainPlan = options.plan && !options.tooling;
                const { records, executionTime, explainPlans } = await runSOQLQuery(conn, query, apiChoice, runExplainPlan);

                if (runExplainPlan && explainPlans) {
                    console.log(chalk.blue('\n=== Explain Plan Results ==='));
                    explainPlans.forEach((plan, index) => {
                        console.log(chalk.blue(`Plan ${index + 1}:`));
                        console.log(JSON.stringify({
                            Cardinality: plan.cardinality || 'N/A',
                            Fields: plan.fields || [],
                            LeadingOperationType: plan.leadingOperationType || 'N/A',
                            RelativeCost: plan.relativeCost || 'N/A',
                            SObject: plan.sobjectType || 'N/A',
                            Notes: plan.notes || []
                        }, null, 2));
                    });
                }

                console.log(chalk.blue('\n=== Query Results (JSON) ==='));
                console.log(JSON.stringify(records, null, 2));
                console.log(chalk.green(`Query execution time: ${executionTime} ms`));

                if (records.length > 0) {
                    await fs.writeFile('query_results.csv', convertToCSV(records));
                    console.log(chalk.magenta('Results exported to query_results.csv'));
                } else {
                    console.log(chalk.yellow('No records to export.'));
                }
            } catch (error) {
                console.error(chalk.red(`Error in SOQL query: ${error.message}`));
                process.exit(1);
            }
        });

    // Command: sfu rest
    program
        .command('rest')
        .description('Call a custom REST API')
        .requiredOption('-m, --method <method>', 'HTTP method (GET, POST, PATCH, DELETE)')
        .option('-p, --payload <payload>', 'Path to JSON payload file (for POST/PATCH)')
        .requiredOption('-r, --resource <resource>', 'Relative REST API URL (e.g., /services/data/v60.0/sobjects/Account/describe)')
        .action(async (options) => {
            const method = options.method.toUpperCase();
            if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
                console.error(chalk.red('Error: Method must be GET, POST, PATCH, or DELETE.'));
                process.exit(1);
            }

            let payload = null;
            if (options.payload && (method === 'POST' || method === 'PATCH')) {
                try {
                    const fileContent = await fs.readFile(options.payload, 'utf8');
                    payload = JSON.parse(fileContent);
                } catch (error) {
                    console.error(chalk.red(`Error reading payload file: ${error.message}`));
                    process.exit(1);
                }
            } else if (options.payload) {
                console.error(chalk.red('Error: Payload is only valid for POST or PATCH methods.'));
                process.exit(1);
            }

            try {
                const conn = await initializeConn();
                const responseData = await callRestApi(conn, method, options.resource, payload);

                console.log(chalk.blue('\n=== REST API Response (JSON) ==='));
                console.log(JSON.stringify(responseData, null, 2));

                await fs.writeFile('rest_api_response.json', JSON.stringify(responseData, null, 2));
                console.log(chalk.magenta('Response exported to rest_api_response.json'));

                if (method === 'GET' && Array.isArray(responseData)) {
                    await fs.writeFile('rest_api_results.csv', convertToCSV(responseData));
                    console.log(chalk.magenta('Results exported to rest_api_results.csv'));
                }
            } catch (error) {
                console.error(chalk.red(`Error calling REST API: ${error.message}`));
                process.exit(1);
            }
        });

    // Command: sfu track
    program
        .command('track')
        .description('Track changes (SourceMember)')
        .option('-d, --date <date>', 'Date to track changes since (YYYY-MM-DD)')
        .option('-u, --user <user>', 'Username of the last modified user')
        .action(async (options) => {
            try {
                const conn = await initializeConn();
                const records = await trackChanges(conn, options.date, options.user);

                if (records.length === 0) {
                    console.log(chalk.yellow('No changes found matching the criteria.'));
                    return;
                }

                console.log(chalk.blue('\n=== Tracked Changes (JSON) ==='));
                console.log(JSON.stringify(records, null, 2));

                await fs.writeFile('tracked_changes.csv', convertToCSV(records));
                console.log(chalk.magenta('Results exported to tracked_changes.csv'));
            } catch (error) {
                console.error(chalk.red(`Error tracking changes: ${error.message}`));
                process.exit(1);
            }
        });

    // Command: sfu bulk
    program
        .command('bulk')
        .description('Run a Bulk API 2.0 job')
        .requiredOption('-s, --sobject <object>', 'Salesforce object (e.g., Account)')
        .requiredOption('-o, --operation <operation>', 'Operation (Insert, Update, Upsert, Delete)')
        .requiredOption('-d, --data <datafile>', 'Path to CSV data file')
        .option('-e, --external-id <externalId>', 'External ID field for Upsert')
        .action(async (options) => {
            const operation = options.operation.charAt(0).toUpperCase() + options.operation.slice(1).toLowerCase();
            if (!['Insert', 'Update', 'Upsert', 'Delete'].includes(operation)) {
                console.error(chalk.red('Error: Operation must be Insert, Update, Upsert, or Delete.'));
                process.exit(1);
            }

            if (operation === 'Upsert' && !options.externalId) {
                console.error(chalk.red('Error: External ID field is required for Upsert.'));
                process.exit(1);
            }

            try {
                const conn = await initializeConn();
                console.log(chalk.yellow('Creating job...'));
                const jobStatus = await runBulkApiJob(conn, options.sobject, operation.toLowerCase(), options.externalId, options.data);

                console.log(chalk.blue('\n=== Final Job Status ==='));
                console.log(chalk.blue(JSON.stringify({
                    id: jobStatus.id,
                    state: jobStatus.state,
                    numberRecordsProcessed: jobStatus.numberRecordsProcessed,
                    numberRecordsFailed: jobStatus.numberRecordsFailed,
                    totalProcessingTime: jobStatus.totalProcessingTime
                }, null, 2)));

                if (jobStatus.numberRecordsProcessed > 0 || jobStatus.numberRecordsFailed > 0) {
                    console.log(chalk.magenta('Successful results exported to bulk_api_successful_results.csv'));
                    if (jobStatus.numberRecordsFailed > 0) {
                        console.log(chalk.magenta('Failed results exported to bulk_api_failed_results.csv'));
                    }
                }
            } catch (error) {
                console.error(chalk.red(`Error executing Bulk API job: ${error.message}`));
                process.exit(1);
            }
        });

    // Command: sfu apex
    program
        .command('apex')
        .description('Run anonymous Apex code')
        .option('-q, --code <code>', 'Apex code string')
        .option('-f, --file <codefile>', 'Path to Apex code file')
        .action(async (options) => {
            if (!options.code && !options.file) {
                console.error(chalk.red('Error: Either --code or --file is required.'));
                process.exit(1);
            }
            if (options.code && options.file) {
                console.error(chalk.red('Error: Use either --code or --file, not both.'));
                process.exit(1);
            }

            let apexCode;
            if (options.file) {
                try {
                    apexCode = await fs.readFile(options.file, 'utf8');
                    apexCode = apexCode.trim();
                    if (!apexCode) throw new Error('Apex file is empty.');
                } catch (error) {
                    console.error(chalk.red(`Error reading Apex file: ${error.message}`));
                    process.exit(1);
                }
            } else {
                apexCode = options.code.trim();
            }

            try {
                const conn = await initializeConn();
                const result = await runApex(conn, apexCode);

                console.log(chalk.blue('\n=== Apex Execution Result (JSON) ==='));
                console.log(JSON.stringify(result, null, 2));
            } catch (error) {
                console.error(chalk.red(`Error executing Apex: ${error.message}`));
                process.exit(1);
            }
        });

    // Initialize connection
    async function initializeConn() {
        let lastUsername = '';
        try {
            lastUsername = await fs.readFile(LAST_USERNAME_FILE, 'utf8');
            lastUsername = lastUsername.trim();
        } catch (error) {
            // File doesn't exist or can't be read
        }

        const username = program.opts().username || lastUsername;
        if (!username) {
            console.error(chalk.red('Error: Salesforce username is required. Use --username or set last_username.txt.'));
            process.exit(1);
        }

        await fs.writeFile(LAST_USERNAME_FILE, username);

        const { accessToken, instanceUrl, apiVersion } = await getSalesforceCredentials(username);
        console.log(chalk.blue('Instance URL:', instanceUrl));
        console.log(chalk.blue('API Version:', apiVersion));

        const conn = await initializeConnection(accessToken, instanceUrl, apiVersion);
        console.log(chalk.green('Successfully connected to Salesforce!'));
        return conn;
    }

    // Convert records to CSV
    function convertToCSV(records) {
        if (!records || records.length === 0) return '';
        const headers = Object.keys(records[0]).filter(key => key !== 'attributes');
        const rows = records.map(record => {
            return headers.map(header => {
                const value = record[header];
                return typeof value === 'object' ? JSON.stringify(value) : `"${String(value).replace(/"/g, '""')}"`;
            }).join(',');
        });
        return headers.join(',') + '\n' + rows.join('\n');
    }

    // Global option for username
    program.option('-u, --username <username>', 'Salesforce username');

    await program.parseAsync(process.argv);
}

main().catch(error => {
    console.error(chalk.red(`Fatal error: ${error.message}`));
    process.exit(1);
});