#!/usr/bin/env node
//sfui .js
// author: Mohan Chinnappan
//----------------------------
// This script handles the UI for a Salesforce utility, prompting users for input and displaying results.
// Core logic is in the lib directory.

const readline = require('readline');
const chalk = require('chalk');
const fs = require('fs').promises;
const {
    getSalesforceCredentials,
    initializeConnection
} = require('./lib/auth');
const { runSOQLQuery } = require('./lib/soql');
const { runApex } = require('./lib/apex');
const { callRestApi } = require('./lib/rest');
const { trackChanges } = require('./lib/track');
const { runBulkApiJob } = require('./lib/bulk');

const LAST_USERNAME_FILE = 'last_username.txt';

// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Prompt user for input
function promptUser(question) {
    return new Promise((resolve) => {
        rl.question(chalk.green(question), (answer) => {
            resolve(answer.trim());
        });
    });
}

// Main menu
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
                await handleSOQLQuery(conn);
                break;
            case '2':
                await handleApex(conn);
                break;
            case '3':
                await handleRestApi(conn);
                break;
            case '4':
                await handleTrackChanges(conn);
                break;
            case '5':
                await handleBulkApiJob(conn);
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

// Handle SOQL query
async function handleSOQLQuery(conn) {
    try {
        console.log(chalk.yellow('Select query source:'));
        console.log(chalk.yellow('1. Enter query interactively'));
        console.log(chalk.yellow('2. Load query from .soql file'));
        const querySourceChoice = await promptUser('Enter the source number (1-2): ');

        let query;
        if (querySourceChoice === '2') {
            const filePath = await promptUser('Enter the path to the .soql file (e.g., query.soql): ');
            try {
                query = await fs.readFile(filePath, 'utf8');
                query = query.trim();
                if (!query) throw new Error('SOQL file is empty.');
                console.log(chalk.blue('Loaded SOQL query:'), query);
                const modifyQuery = await promptUser('Do you want to modify the loaded query? (yes/no): ');
                if (modifyQuery.toLowerCase() === 'yes') {
                    const newQuery = await promptUser('Enter the new SOQL query: ');
                    if (newQuery) {
                        query = newQuery.trim();
                        console.log(chalk.blue('Updated SOQL query:'), query);
                    }
                }
            } catch (error) {
                console.error(chalk.red('Error reading SOQL file:', error.message));
                return;
            }
        } else if (querySourceChoice === '1') {
            query = await promptUser('Enter your SOQL query (e.g., SELECT Id, Name FROM Account LIMIT 10): ');
            if (!query) {
                console.error(chalk.red('SOQL query cannot be empty.'));
                return;
            }
        } else {
            console.error(chalk.red('Invalid source selected. Please try again.'));
            return;
        }

        console.log(chalk.yellow('Select API to execute query:'));
        console.log(chalk.yellow('1. Standard API'));
        console.log(chalk.yellow('2. Tooling API'));
        const apiChoice = await promptUser('Enter the API number (1-2): ');

        let runExplainPlan = false;
        if (apiChoice === '1') {
            const explainChoice = await promptUser('Run Explain Plan for this query? (yes/no): ');
            if (explainChoice.toLowerCase() === 'yes') {
                runExplainPlan = true;
            }
        } else if (apiChoice !== '2') {
            console.error(chalk.red('Invalid API selected. Please try again.'));
            return;
        }

        const proceed = await promptUser('Proceed with query execution? (yes/no): ');
        if (proceed.toLowerCase() !== 'yes') {
            console.log(chalk.yellow('Query execution skipped.'));
            return;
        }

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

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes') {
            if (records.length === 0) {
                console.log(chalk.yellow('No records to export.'));
                return;
            }
            console.log(chalk.magenta('Results exported to query_results.csv'));
        }
    } catch (error) {
        console.error(chalk.red('Error in SOQL query:', error.message));
    }
}

// Handle Apex execution
async function handleApex(conn) {
    try {
        const apexCode = await promptUser('Enter your anonymous Apex code (end with Ctrl+D on a new line):\n');
        const result = await runApex(conn, apexCode);
        console.log(chalk.blue('\n=== Apex Execution Result (JSON) ==='));
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(chalk.red('Error executing Apex:', error.message));
    }
}

// Handle REST API call
async function handleRestApi(conn) {
    try {
        console.log(chalk.yellow('Select HTTP method:'));
        console.log(chalk.yellow('1. GET'));
        console.log(chalk.yellow('2. POST'));
        console.log(chalk.yellow('3. PATCH'));
        console.log(chalk.yellow('4. DELETE'));
        const methodChoice = await promptUser('Enter the method number (1-4): ');

        let method;
        switch (methodChoice) {
            case '1': method = 'GET'; break;
            case '2': method = 'POST'; break;
            case '3': method = 'PATCH'; break;
            case '4': method = 'DELETE'; break;
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

        const responseData = await callRestApi(conn, method, relativeUrl, payload);

        console.log(chalk.blue('\n=== REST API Response (JSON) ==='));
        console.log(JSON.stringify(responseData, null, 2));

        const exportToJson = await promptUser('Export response to JSON file? (yes/no): ');
        if (exportToJson.toLowerCase() === 'yes') {
            await fs.writeFile('rest_api_response.json', JSON.stringify(responseData, null, 2));
            console.log(chalk.magenta('Response exported to rest_api_response.json'));
        }

        if (method === 'GET' && Array.isArray(responseData)) {
            const outputFormat = await promptUser('Export to CSV? (yes/no): ');
            if (outputFormat.toLowerCase() === 'yes') {
                console.log(chalk.magenta('Results exported to rest_api_results.csv'));
            }
        }
    } catch (error) {
        console.error(chalk.red('Error calling REST API:', error.message));
    }
}

// Handle track changes
async function handleTrackChanges(conn) {
    try {
        console.log(chalk.yellow('Note: Change tracking only works in sandboxes and scratch orgs, not in production orgs.'));
        const sinceDate = await promptUser('Enter the date to track changes since (YYYY-MM-DD, e.g., 2025-04-01), or press Enter for all changes: ');
        const lastModifiedByUsername = await promptUser('Enter the username of the last modified by user (e.g., user@example.org), or press Enter to skip: ');

        const records = await trackChanges(conn, sinceDate, lastModifiedByUsername);

        if (records.length === 0) {
            console.log(chalk.yellow('No changes found matching the criteria.'));
            return;
        }

        console.log(chalk.blue('\n=== Tracked Changes (JSON) ==='));
        console.log(JSON.stringify(records, null, 2));

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes') {
            console.log(chalk.magenta('Results exported to tracked_changes.csv'));
        }

        const generatePackage = await promptUser('Generate package.xml for these changes? (yes/no): ');
        if (generatePackage.toLowerCase() === 'yes') {
            console.log(chalk.green('package.xml generated successfully.'));
        }
    } catch (error) {
        console.error(chalk.red('Error tracking changes:', error.message));
    }
}

// Handle Bulk API job
async function handleBulkApiJob(conn) {
    try {
        // Test connection
        try {
            await conn.query('SELECT Id FROM Account LIMIT 1');
            console.log(chalk.green('Connection verified successfully.'));
        } catch (error) {
            console.error(chalk.red('Connection test failed:', error.message));
            return;
        }

        const sObject = await promptUser('Enter the Salesforce object (e.g., Account, Contact): ');

        // Validate object
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
            case '1': operation = 'insert'; break;
            case '2': operation = 'update'; break;
            case '3': operation = 'upsert'; break;
            case '4': operation = 'delete'; break;
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

        const csvFilePath = await promptUser('Enter the path to the CSV file (e.g., data.csv): ');

        console.log(chalk.yellow('Creating job...'));
        const jobStatus = await runBulkApiJob(conn, sObject, operation, externalIdFieldName, csvFilePath);

        console.log(chalk.blue('\n=== Final Job Status ==='));
        console.log(chalk.blue(JSON.stringify({
            id: jobStatus.id,
            state: jobStatus.state,
            numberRecordsProcessed: jobStatus.numberRecordsProcessed,
            numberRecordsFailed: jobStatus.numberRecordsFailed,
            totalProcessingTime: jobStatus.totalProcessingTime
        }, null, 2)));

        if (jobStatus.numberRecordsFailed > 0 || (await promptUser('Export job results to CSV? (yes/no): ')).toLowerCase() === 'yes') {
            console.log(chalk.magenta('Successful results exported to bulk_api_successful_results.csv'));
            if (jobStatus.numberRecordsFailed > 0) {
                console.log(chalk.magenta('Failed results exported to bulk_api_failed_results.csv'));
            }
        }
    } catch (error) {
        console.error(chalk.red('Error executing Bulk API job:', error.message));
    }
}

// Main function
(async () => {
    try {
        let lastUsername = '';
        try {
            lastUsername = await fs.readFile(LAST_USERNAME_FILE, 'utf8');
            lastUsername = lastUsername.trim();
        } catch (error) {
            // File doesn't exist or can't be read
        }

        const defaultPrompt = lastUsername ? ` (default: ${lastUsername})` : '';
        const username = await promptUser(`Enter your Salesforce username${defaultPrompt}: `) || lastUsername;
        if (!username) {
            throw new Error('Salesforce username is required.');
        }

        await fs.writeFile(LAST_USERNAME_FILE, username);

        const { accessToken, instanceUrl, apiVersion } = await getSalesforceCredentials(username);
        console.log(chalk.blue('Instance URL:', instanceUrl));
        console.log(chalk.blue('API Version:', apiVersion));

        const conn = await initializeConnection(accessToken, instanceUrl, apiVersion);
        console.log(chalk.green('Successfully connected to Salesforce!'));
        await mainMenu(conn);
    } catch (error) {
        console.error(chalk.red('Failed to initialize:', error.message));
        rl.close();
    }
})();