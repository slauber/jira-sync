const JiraApi = require('jira-client');
const aesjs = require('aes-js')
const dayjs = require('dayjs')
const fs = require("fs")
const locale_de = require("dayjs/locale/de")
const customParseFormat = require('dayjs/plugin/customParseFormat')
const express = require('express')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')

const app = express();
const COOKIE_NAME = "jiraCredentials"
const CARD_FIELDS = "assignee,summary,updated,created,parent,status,issuetype"
const JIRA_DATE_FORMAT = "YYYY-MM-DD"

// exclude specific changes
const EXCLUDED_CHANGES = ["epic link", "description", "rank", "attachment", "resolution"]

// Configure date format
dayjs.locale('de')
dayjs.extend(customParseFormat)

// Default parameters for JIRA
const jiraConfig = {
    protocol: 'https',
    apiVersion: '2',
    strictSSL: true
}

// Use environment for consistent deployment on heroku
const DEFAULT_PORT = process.env.PORT || 3003
let config = {
    port: DEFAULT_PORT,
    key: process.env.COOKIE_KEY ? process.env.COOKIE_KEY.split(",").map(x => +x) : null
};

// Read config
const CONFIG_PATH = ".jiraconfig"
if (!config.key) {
    fs.readFile(CONFIG_PATH, "utf-8", async (err, data) => {
        if (err) {
            generateKey()
        } else {
            try {
                config = JSON.parse(data);
                if (config.key && config.key.length != 16) {
                    generateKey()
                }
                if (!config.port) {
                    config.port = DEFAULT_PORT;
                }
            } catch (error) {
                generateKey()
            }
        }
    })
}

app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }))

app.use(express.static(__dirname + '/public'));
app.use(async (req, res, next) => {
    const cookie = req.cookies[COOKIE_NAME];
    let credentials;
    try {
        credentials = decryptCookie(cookie);
        req.jira = await getJiraConnection(credentials);
    } catch (error) {
        if (req.originalUrl !== "/check") {
            try {
                const body = req.body;
                credentials = {
                    username: body.username,
                    password: body.password,
                    host: body.host
                }
                req.jira = await getJiraConnection(credentials);
                res.cookie(COOKIE_NAME, encryptCookie(credentials), { maxAge: 1209600000, httpOnly: true })
            } catch (error1) {
                return res.send(401)
            }
        } else {
            return res.send({ loggedIn: false })
        }
    }
    next();
});

// Routes
app.post('/delta', async (req, res) => {
    const boardId = req.body.boardId + "";
    // todo improve date handling
    const sinceDate = dayjs(req.body.since, "DD.MM.YYYY").add(8, 'hour');
    const jira = req.jira;

    // get current sprint
    const currentSprint = await jira.getLastSprintForRapidView(boardId);

    // get metadata for your sprint
    const sprintInfo = (await jira.getSprintIssues(boardId, currentSprint.id)).contents;

    const newIssues = (await jira.getBoardIssuesForSprint(boardId, currentSprint.id, null, 9999, `updatedDate >  ${sinceDate.format(JIRA_DATE_FORMAT)} and createdDate > ${sinceDate.format(JIRA_DATE_FORMAT)}`, true, CARD_FIELDS))
    const newIssuesFormatted = newIssues.issues.map(issueSummary);

    // nimm alle issues, die nach dem Tagesbeginn des sinceDate aktualisiert wurden (aber früher erstellt) und lade für jeden das Changelog
    const changedAndNotNew = (await jira.getBoardIssuesForSprint(boardId, currentSprint.id, null, 9999, `updatedDate  >  ${sinceDate.format(JIRA_DATE_FORMAT)} and createdDate < ${sinceDate.format(JIRA_DATE_FORMAT)}`, true, CARD_FIELDS)).issues;
    const changedAndNotNewWithHistory = await Promise.all(changedAndNotNew.map(issue => jira.getIssue(issue.key, CARD_FIELDS, "changelog")))

    // remove all irrelevant entries (see)
    const changedAndNotNewWithHistoryFiltered = changedAndNotNewWithHistory.map(issue => {
        issue.changelog = issue.changelog.histories.filter(change => (dayjs(change.created) > sinceDate) && !EXCLUDED_CHANGES.includes(change.items[0].field.toLowerCase()))
        return issue;
    }).filter(issue => issue.changelog.length > 0)
        .map(issueSummary)
        .sort((a, b) => {
            if (a.parent > b.parent) return 1;
            if (a.parent < a.parent) return -1;
            return 0;
        })

    res.send(JSON.stringify({
        newIssuesFormatted,
        changedAndNotNewWithHistoryFiltered,
        sprintGoal: currentSprint.goal,
        sprintName: currentSprint.name,
        estimateOpen: sprintInfo.issuesNotCompletedEstimateSum.value,
        estimateAll: sprintInfo.allIssuesEstimateSum.value,
        estimateDone: sprintInfo.completedIssuesEstimateSum.value ? sprintInfo.completedIssuesEstimateSum.value : 0
    }));
})

app.post('/getInfo', async (req, res) => {
    const jira = req.jira;
    const boardId = req.body.boardId;

    const activeSprints = (await jira.getAllSprints(boardId, null, null, "active")).values;
    const selectedSprint = activeSprints[0]
    const sprintInfo = await jira.getSprintIssues(boardId, activeSprints[0].id)

    const sprintGoal = selectedSprint.goal;
    const openIssueEstimation = sprintInfo.contents.issuesNotCompletedEstimateSum.value;
    const completedIssueEstimation = sprintInfo.contents.completedIssuesEstimateSum.value;

    res.send(`Sprintziel: "${sprintGoal}" - Offen: ${openIssueEstimation} - Abgeschlossen: ${completedIssueEstimation ? completedIssueEstimation : 0}`)
})

app.get('/getBoards', async (req, res) => {
    const jira = req.jira;
    const boardTypes = []
    const boards = (await jira.getAllBoards(null, 9999)).values.map(board => {
        if (!boardTypes.includes(board.type)) {
            boardTypes.push(board.type)
        }
        return { id: board.id, text: board.name, type: board.type }
    });

    const results = []

    for (boardType of boardTypes) {
        const boardTypeBoards = boards.filter(board => board.type === boardType)
        results.push({
            text: boardType[0].toUpperCase() + boardType.slice(1),
            children: boardTypeBoards.map(board => { return { id: board.id, text: board.text } })
        })
    }
    res.send(results)
})

app.post('/check', async (req, res) => {
    res.send({ loggedIn: true });
})

app.post('/login', async (req, res) => {
    res.redirect("/");
})

app.post('/logout', async (req, res) => {
    res.cookie(COOKIE_NAME, "", { maxAge: 0 })
    res.redirect("/");
})

app.listen(config.port, () => {
    console.log(`JiraSync running on port ${config.port}`)
})


// helper
function generateKey() {
    config.key = Array.from(new Uint8Array(require("crypto").randomBytes(16)));
    writeConfig()
}

function writeConfig() {
    fs.writeFile(CONFIG_PATH, JSON.stringify(config), (err) => {
        if (err) console.log(err);
    });
}

function issueSummary(issue) {
    return {
        key: issue.key,
        summary: issue.fields.summary,
        updated: issue.fields.updated,
        status: issue.fields.status.name,
        parent: issue.fields.parent ? issue.fields.parent.key : null,
        assignee: issue.fields.assignee ? issue.fields.assignee.displayName : null,
        issuetype: issue.fields.issuetype.name
    }
}

function encryptCookie(credentials) {
    const credentialString = JSON.stringify(credentials);
    const credentialStringBytes = aesjs.utils.utf8.toBytes(credentialString);
    const aesCtr = new aesjs.ModeOfOperation.ctr(config.key);
    const encryptedBytes = aesCtr.encrypt(credentialStringBytes);
    const encryptedHex = aesjs.utils.hex.fromBytes(encryptedBytes);
    return encryptedHex
}

function decryptCookie(credentialCookie) {
    const encryptedBytesDec = aesjs.utils.hex.toBytes(credentialCookie);
    const aesCtrDecrypt = new aesjs.ModeOfOperation.ctr(config.key);
    const decryptedBytes = aesCtrDecrypt.decrypt(encryptedBytesDec);
    return JSON.parse(aesjs.utils.utf8.fromBytes(decryptedBytes));
}

async function getJiraConnection(credentials) {
    const jira = new JiraApi({
        ...jiraConfig,
        ...credentials
    })
    const user = await jira.getCurrentUser();
    if (!user) {
        throw new Error("Invalid credentials")
    }
    return jira;
}