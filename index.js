//----------------------------
// index.js
// author: Mohan Chinnappan
//----------------------------

// This script is a command-line utility for Salesforce developers to run SOQL queries, execute anonymous Apex code, call custom REST APIs, and track changes in Salesforce.
// It uses the jsforce library to connect to Salesforce and perform these operations.
// It also uses the csv-writer library to export query results to CSV files.
// The script prompts the user for input and provides options to execute different tasks.
// It requires the following dependencies:
// - jsforce: For Salesforce API interactions
// - csv-writer: For exporting query results to CSV files
// - axios: For making HTTP requests to custom REST APIs
// - readline: For reading user input from the command line
// - util: For promisifying the exec function
// - child_process: For executing shell commands
// - fs: For file system operations
// - chalk: For colored console output

const { exec } = require('child_process');
const util = require('util');
const jsforce = require('jsforce');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');
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
// This function prompts the user for a SOQL query, executes it, and handles pagination if necessary.
// It also offers the option to export the results to a CSV file.
// The function uses the jsforce library to interact with Salesforce and axios for HTTP requests.
// It also uses the csv-writer library to export the results to a CSV file.
// The function handles errors that may occur during the execution of the query and provides feedback to the user.
// It also handles the case where the user may want to export the results to a CSV file.

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
            // Exclude 'attributes' field from CSV headers
            const headers = Object.keys(allRecords[0] || {})
                .filter(key => key !== 'attributes')
                .map(key => ({ id: key, title: key }));

            const csvWriter = createObjectCsvWriter({
                path: 'query_results.csv',
                header: headers
            });

            // Optionally, you can remove 'attributes' from records, but csv-writer will only use the fields in the header
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
// This function prompts the user for the HTTP method (GET, POST, PATCH, DELETE), the REST API URL, and optionally a JSON payload file.
// It then makes the HTTP request using axios and handles the response.
// The function also offers the option to export the response to a JSON file and, for GET requests, to a CSV file.
// It handles errors that may occur during the HTTP request and provides feedback to the user.
// It also handles the case where the user may want to export the response to a JSON file or a CSV file.

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

        // Offer JSON export for all methods
        const exportToJson = await promptUser('Export response to JSON file? (yes/no): ');
        if (exportToJson.toLowerCase() === 'yes') {
            await fs.writeFile('rest_api_response.json', JSON.stringify(allData, null, 2));
            console.log(chalk.magenta('Response exported to rest_api_response.json'));
        }

        // Offer CSV export only for GET requests that return a list of records
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
// This function retrieves the user ID based on the provided username.
// It uses a SOQL query to fetch the user ID from the User object.
// If the user is not found, it throws an error.
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
// This function allows the user to track changes in the SourceMember object.
// It prompts the user for a date to track changes since and the username of the last modified by user.
// It constructs a SOQL query based on the provided criteria and executes it.
// The function handles pagination if more records exist and offers the option to export the results to a CSV file.
// It also generates a package.xml file based on the tracked changes.
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
        // Initial query
        let result = await conn.tooling.query(query);
        let allRecords = result.records || [];

        // Handle pagination if more records exist
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
            //console.log('Run the following command in your SFDX project to retrieve the changes:');
            //console.log(chalk.cyan(`sf project retrieve start -x package.xml -o ${await promptUser('Enter your SFDX username: ')}`));
        }
    } catch (error) {
        console.error(chalk.red('Error tracking changes:', error.message));
    }
}

// Function to generate package.xml based on tracked changes
// This function takes the tracked changes records and generates a package.xml file.
// It groups the records by MemberType and creates the appropriate XML structure.
// The function returns the generated XML string.
// The generated package.xml can be used for retrieving metadata from Salesforce using the SFDX CLI.
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

// Main menu function
// This function presents the main menu to the user and handles their choices.
// It uses a while loop to keep the menu active until the user chooses to exit.
// The function calls the appropriate functions based on the user's choice.
// It also handles invalid input and provides feedback to the user.
// The function uses the chalk library to color the console output for better readability.
// The main menu includes options to run SOQL queries, execute anonymous Apex code, call custom REST APIs, and track changes in SourceMember.
// It also includes an option to exit the program.
// The function uses async/await to handle asynchronous operations and ensure a smooth user experience.
async function mainMenu(conn) {
    while (true) {
        console.log(chalk.cyan.bold('\n=== SF Utils - Salesforce SOQL Query and Run Apex ==='));
        console.log(chalk.yellow('1. Run SOQL Query'));
        console.log(chalk.yellow('2. Run Anonymous Apex'));
        console.log(chalk.yellow('3. Call Custom REST API URL'));
        console.log(chalk.yellow('4. Track Changes (SourceMember)'));
        console.log(chalk.yellow('5. Exit'));
        
        const choice = await promptUser('Select an option (1-5): ');

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
        // Read the last username, if it exists
        let lastUsername = '';
        try {
            lastUsername = await fs.readFile(LAST_USERNAME_FILE, 'utf8');
            lastUsername = lastUsername.trim();
        } catch (error) {
            // File doesn't exist or can't be read; proceed with empty default
        }

        // Prompt for username with last username as default
        const defaultPrompt = lastUsername ? ` (default: ${lastUsername})` : '';
        const username = await promptUser(`Enter your Salesforce username${defaultPrompt}: `) || lastUsername;
        if (!username) {
            throw new Error('Salesforce username is required.');
        }

        // Save the entered username for next time
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