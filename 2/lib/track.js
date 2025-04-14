// lib/track.js
const { createObjectCsvWriter } = require('csv-writer');
const { getUserIdFromUsername, generatePackageXml } = require('./utils');

async function trackChanges(conn, sinceDate, lastModifiedByUsername) {
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

    if (lastModifiedByUsername) {
        const lastModifiedById = await getUserIdFromUsername(conn, lastModifiedByUsername);
        conditions.push(`LastModifiedById = '${lastModifiedById}'`);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY LastModifiedDate DESC';

    let result = await conn.tooling.query(query);
    let allRecords = result.records || [];

    while (!result.done && result.nextRecordsUrl) {
        result = await conn.requestGet(result.nextRecordsUrl);
        allRecords = allRecords.concat(result.records || []);
    }

    if (allRecords.length > 0) {
        const csvWriter = createObjectCsvWriter({
            path: 'tracked_changes.csv',
            header: [
                { id: 'Id', title: 'Id' },
                { id: 'LastModifiedByName', title: 'Last Modified By Name' },
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
            Id: record.Id,
            LastModifiedByName: record.LastModifiedBy && record.LastModifiedBy.Name ? record.LastModifiedBy.Name : 'N/A',
            MemberIdOrName: record.MemberIdOrName,
            MemberType: record.MemberType,
            MemberName: record.MemberName,
            RevisionNum: record.RevisionNum,
            RevisionCounter: record.RevisionCounter,
            IsNameObsolete: record.IsNameObsolete,
            LastModifiedById: record.LastModifiedById,
            IsNewMember: record.IsNewMember,
            ChangedBy: record.ChangedBy
        }));

        await csvWriter.writeRecords(flattenedRecords);

        const packageXml = generatePackageXml(allRecords);
        console.log('DEBUG: Generated package.xml:', packageXml);
        await require('fs').promises.writeFile('package.xml', packageXml);
    }

    return allRecords;
}

module.exports = { trackChanges };