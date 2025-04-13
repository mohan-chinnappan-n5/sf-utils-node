const { exec } = require('child_process');
const util = require('util');
const jsforce = require('jsforce');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');

const execPromise = util.promisify(exec);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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
async function callRestApi(conn) {
    const relativeUrl = await promptUser('Enter the REST API URL (e.g., /services/data/v59.0/sobjects/Account/describe): ');
    try {
        // Initial API call
        let response = await axios.get(`${conn.instanceUrl}${relativeUrl}`, {
            headers: {
                'Authorization': `Bearer ${conn.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        let allData = [];
        let responseData = response.data;

        // Find the first array field in the response (e.g., recipes, sobjects, records)
        const getRecordsArray = (data) => {
            for (const key in data) {
                if (Array.isArray(data[key])) {
                    return { key, records: data[key] };
                }
            }
            return { key: null, records: [] };
        };

        // Check if the response has pagination with nextPageUrl (or nextRecordsUrl for query endpoints)
        let { key: recordsKey, records } = getRecordsArray(responseData);
        if ((responseData.nextPageUrl || (responseData.nextRecordsUrl && !responseData.done)) && recordsKey) {
            allData = records || [];

            // Fetch additional pages
            while (responseData.nextPageUrl || (responseData.nextRecordsUrl && !responseData.done)) {
                const nextUrl = responseData.nextPageUrl || responseData.nextRecordsUrl;
                console.log(chalk.yellow(`Fetching more records... (${allData.length}${responseData.totalSize ? ` of ${responseData.totalSize}` : ''} retrieved)`));
                response = await axios.get(`${conn.instanceUrl}${nextUrl}`, {
                    headers: {
                        'Authorization': `Bearer ${conn.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                responseData = response.data;
                records = responseData[recordsKey] || [];
                allData = allData.concat(records);
            }
        } else {
            // If no pagination, use the response data as-is
            allData = Array.isArray(responseData) ? responseData : records.length > 0 ? records : [responseData];
        }

        console.log(chalk.blue('\n=== REST API Response (JSON) ==='));
        console.log(JSON.stringify(allData, null, 2));

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes' && Array.isArray(allData)) {
            const csvWriter = createObjectCsvWriter({
                path: 'rest_api_results.csv',
                header: Object.keys(allData[0] || {})
                    .filter(key => key !== 'attributes')
                    .map(key => ({ id: key, title: key }))
            });
            await csvWriter.writeRecords(allData);
            console.log(chalk.magenta('Results exported to rest_api_results.csv'));
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
            console.log('Run the following command in your SFDX project to retrieve the changes:');
            console.log(chalk.cyan(`sf project retrieve start -x package.xml -o ${await promptUser('Enter your SFDX username: ')}`));
        }
    } catch (error) {
        console.error(chalk.red('Error tracking changes:', error.message));
    }
}

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
        const username = await promptUser('Enter your Salesforce username: ');
        const { accessToken, instanceUrl } = await getSalesforceCredentials(username);
        const conn = await initializeConnection(accessToken, instanceUrl);
        console.log(chalk.green('Successfully connected to Salesforce!'));
        await mainMenu(conn);
    } catch (error) {
        console.error(chalk.red('Failed to initialize:', error.message));
        rl.close();
    }
})();