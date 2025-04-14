// lib/auth.js
const { exec } = require('child_process');
const util = require('util');
const jsforce = require('jsforce');

const execPromise = util.promisify(exec);

async function getSalesforceCredentials(username) {
    const { stdout } = await execPromise(`sf org display -u ${username} --json`);
    const result = JSON.parse(stdout);
    const accessToken = result.result.accessToken;
    const instanceUrl = result.result.instanceUrl;
    const apiVersion = result.result.apiVersion || '60.0';
    return { accessToken, instanceUrl, apiVersion };
}

function initializeConnection(accessToken, instanceUrl, apiVersion) {
    const conn = new jsforce.Connection({
        instanceUrl,
        accessToken
    });
    conn.apiVersion = apiVersion;
    return conn;
}

module.exports = {
    getSalesforceCredentials,
    initializeConnection
};