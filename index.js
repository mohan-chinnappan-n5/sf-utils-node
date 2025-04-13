const { exec } = require('child_process');
const util = require('util');
const jsforce = require('jsforce');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');
const axios = require('axios');
const fs = require('fs').promises;

const execPromise = util.promisify(exec);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function promptUser(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

async function getSalesforceCredentials(username) {
    try {
        const { stdout } = await execPromise(`sf org display -u ${username} --json`);
        const result = JSON.parse(stdout);
        const accessToken = result.result.accessToken;
        const instanceUrl = result.result.instanceUrl;
        return { accessToken, instanceUrl };
    } catch (error) {
        console.error('Error retrieving Salesforce credentials:', error.message);
        throw error;
    }
}

async function initializeConnection(accessToken, instanceUrl) {
    const conn = new jsforce.Connection({
        instanceUrl: instanceUrl,
        accessToken: accessToken
    });
    return conn;
}

async function runSOQLQuery(conn) {
    const query = await promptUser('Enter your SOQL query (e.g., SELECT Id, Name FROM Account LIMIT 10): ');
    try {
        const result = await conn.query(query);
        console.log('\n=== Query Results (JSON) ===');
        console.log(JSON.stringify(result.records, null, 2));

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes') {
            const csvWriter = createObjectCsvWriter({
                path: 'query_results.csv',
                header: Object.keys(result.records[0] || {}).map(key => ({ id: key, title: key }))
            });
            await csvWriter.writeRecords(result.records);
            console.log('Results exported to query_results.csv');
        }
    } catch (error) {
        console.error('Error executing SOQL query:', error.message);
    }
}

async function runApex(conn) {
    const apexCode = await promptUser('Enter your anonymous Apex code (end with Ctrl+D on a new line):\n');
    try {
        const result = await conn.tooling.executeAnonymous(apexCode);
        console.log('\n=== Apex Execution Result (JSON) ===');
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error executing Apex:', error.message);
    }
}

async function callRestApi(conn) {
    const relativeUrl = await promptUser('Enter the REST API URL (e.g., /services/data/v59.0/sobjects/Account/describe): ');
    try {
        const response = await axios.get(`${conn.instanceUrl}${relativeUrl}`, {
            headers: {
                'Authorization': `Bearer ${conn.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        console.log('\n=== REST API Response (JSON) ===');
        console.log(JSON.stringify(response.data, null, 2));

        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes' && Array.isArray(response.data)) {
            const csvWriter = createObjectCsvWriter({
                path: 'rest_api_results.csv',
                header: Object.keys(response.data[0] || {}).map(key => ({ id: key, title: key }))
            });
            await csvWriter.writeRecords(response.data);
            console.log('Results exported to rest_api_results.csv');
        }
    } catch (error) {
        console.error('Error calling REST API:', error.message);
    }
}

async function trackChanges(conn) {
    console.log('Note: Change tracking only works in sandboxes and scratch orgs, not in production orgs.');
    const sinceDate = await promptUser('Enter the date to track changes since (YYYY-MM-DD, e.g., 2025-04-01), or press Enter for all changes: ');
    
    // Construct the Tooling API query
    let query = 'SELECT MemberType, MemberName, RevisionNum, LastModifiedDate, LastModifiedById FROM SourceMember';
    if (sinceDate) {
        query += ` WHERE LastModifiedDate >= ${sinceDate}T00:00:00Z`;
    }
    query += ' ORDER BY LastModifiedDate DESC';

    try {
        const result = await conn.tooling.query(query);
        const records = result.records || [];
        if (records.length === 0) {
            console.log('No changes found.');
            return;
        }

        // Display results in JSON
        console.log('\n=== Tracked Changes (JSON) ===');
        console.log(JSON.stringify(records, null, 2));

        // Export to CSV if requested
        const outputFormat = await promptUser('Export to CSV? (yes/no): ');
        if (outputFormat.toLowerCase() === 'yes') {
            const csvWriter = createObjectCsvWriter({
                path: 'tracked_changes.csv',
                header: [
                    { id: 'MemberType', title: 'Member Type' },
                    { id: 'MemberName', title: 'Member Name' },
                    { id: 'RevisionNum', title: 'Revision Number' },
                    { id: 'LastModifiedDate', title: 'Last Modified Date' },
                    { id: 'LastModifiedById', title: 'Last Modified By' }
                ]
            });
            await csvWriter.writeRecords(records);
            console.log('Results exported to tracked_changes.csv');
        }

        // Generate package.xml if requested
        const generatePackage = await promptUser('Generate package.xml for these changes? (yes/no): ');
        if (generatePackage.toLowerCase() === 'yes') {
            const packageXml = generatePackageXml(records);
            await fs.writeFile('package.xml', packageXml);
            console.log('package.xml generated successfully.');
            console.log('Run the following command in your SFDX project to retrieve the changes:');
            console.log(`sf project retrieve start -x package.xml -o ${await promptUser('Enter your SFDX username: ')}`);
        }
    } catch (error) {
        console.error('Error tracking changes:', error.message);
    }
}

// Function to generate package.xml from SourceMember records
function generatePackageXml(records) {
    // Group records by MemberType
    const typesMap = new Map();
    records.forEach(record => {
        if (!typesMap.has(record.MemberType)) {
            typesMap.set(record.MemberType, []);
        }
        typesMap.get(record.MemberType).push(record.MemberName);
    });

    // Generate package.xml content
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
        console.log('\n=== SF Utils - Salesforce SOQL Query and Run Apex ===');
        console.log('1. Run SOQL Query');
        console.log('2. Run Anonymous Apex');
        console.log('3. Call Custom REST API URL');
        console.log('4. Track Changes (SourceMember)');
        console.log('5. Exit');
        
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
                console.log('Exiting...');
                rl.close();
                return;
            default:
                console.log('Invalid option. Please try again.');
        }
    }
}

(async () => {
    try {
        const username = await promptUser('Enter your Salesforce username: ');
        const { accessToken, instanceUrl } = await getSalesforceCredentials(username);
        const conn = await initializeConnection(accessToken, instanceUrl);
        console.log('Successfully connected to Salesforce!');
        await mainMenu(conn);
    } catch (error) {
        console.error('Failed to initialize:', error.message);
        rl.close();
    }
})();