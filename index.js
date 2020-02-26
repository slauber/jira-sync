const JiraApi = require('jira-client');
const aesjs = require('aes-js')
const dayjs = require('dayjs')
const fs = require("fs")
const locale_de = require("dayjs/locale/de")
const customParseFormat = require('dayjs/plugin/customParseFormat')
const express = require('express')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')

// Create express server with cookie and body-parser
const app = express();
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }))

// Include static frontend
app.use(express.static(__dirname + '/public'));

// Constants
const CONFIG_PATH = ".jiraconfig"
const COOKIE_NAME = "jiraCredentials"
const JIRA_DATE_FORMAT = "YYYY-MM-DD"
const GUI_DATE_FORMAT = "DD.MM.YYYY"

// Configure date format
dayjs.locale('de')
dayjs.extend(customParseFormat)

// Default config
let config = {
    port: process.env.PORT || 3003,
    key: null, // see generateKey() below
    estimationField: process.env.ESTIMATION_FIELD || "customfield_10002",
    excludedChanges: process.env.EXCLUDED_CHANGES ? process.env.EXCLUDED_CHANGES.split(",").toLowerCase() : ["epic link", "rank", "attachment", "description", "remoteissuelink", "workflow", "comment", "labels", "link", "resolution"],
    jira: {
        protocol: 'https',
        apiVersion: '2',
        strictSSL: true
    },
    // the current version does not support kanban-type boards
    excludedBoardTypes: process.env.EXCLUDED_BOARD_TYPES || ["kanban"]
};

// Read config from config file (and generate key if necessary)
readConfig();

// Set this constant after reading the config
const CARD_FIELDS = `assignee,summary,updated,created,parent,status,issuetype,${config.estimationField}`

// Check JIRA credentials
app.use(async (req, res, next) => {
    const cookie = req.cookies[COOKIE_NAME];
    let credentials;
    try {
        // Sign in with credentials from cookie
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
                res.cookie(COOKIE_NAME, encryptCookie(credentials), { maxAge: (14 * 24 * 60 * 60 * 1000), httpOnly: true })
            } catch (error1) {
                return res.send(401)
            }
        } else {
            return res.send({ loggedIn: false })
        }
    }
    next();
});

// Get delta since specified date for board
app.post('/delta', async (req, res) => {
    const boardId = req.body.boardId + "";
    // todo improve date handling
    const sinceDate = dayjs(req.body.since, GUI_DATE_FORMAT).add(8, 'hour');
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
        issue.changelog = issue.changelog.histories.filter(change => (dayjs(change.created) > sinceDate) && !config.excludedChanges.includes(change.items[0].field.toLowerCase()))
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

// Get sprint info
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

// Get boards for selection
app.get('/getBoards', async (req, res) => {
    const jira = req.jira;
    const boardTypes = []
    const boards = (await jira.getAllBoards(null, 9999)).values
        .filter(board => !config.excludedBoardTypes.includes(board.type.toLowerCase()))
        .map(board => {
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

// Check login credentials
app.post('/check', async (req, res) => {
    res.send({ loggedIn: true });
})

// Login route
app.post('/login', async (req, res) => {
    res.redirect("/");
})

// Logout route
app.post('/logout', async (req, res) => {
    res.cookie(COOKIE_NAME, "", { maxAge: 0 })
    res.redirect("/");
})

app.listen(config.port, () => {
    console.log(`JiraSync running on port ${config.port}`)
})


// helper
//

// Generate key for encrypted cookie
function generateKey() {
    // generates new key only if there is no external key enforced by the process environment
    config.key = (process.env.COOKIE_KEY ? process.env.COOKIE_KEY.split(",").map(x => +x) : null) || Array.from(new Uint8Array(require("crypto").randomBytes(16)));
}

function readConfig() {
    fs.readFile(CONFIG_PATH, "utf-8", async (err, data) => {
        try {
            if (!err) {
                config = { ...config, ...JSON.parse(data) };
                if (config.key && config.key.length != 16) {
                    throw new Error("Invalid key length")
                }
            } else {
                throw new Error("No config file")
            }
        } catch (e) {
            console.log(e);
            generateKey()
            writeConfig()
        }
    })
}

function writeConfig() {
    fs.writeFile(CONFIG_PATH, JSON.stringify(config), (err) => {
        if (err) console.log(err);
    });
}

// Simplify values for frontend delivery
function issueSummary(issue) {
    return {
        key: issue.key,
        summary: issue.fields.summary,
        updated: issue.fields.updated,
        status: issue.fields.status.name,
        estimate: issue.fields[config.estimationField] ? issue.fields[config.estimationField] : null,
        parent: issue.fields.parent ? issue.fields.parent.key : null,
        assignee: issue.fields.assignee ? issue.fields.assignee.displayName : null,
        assigneePic: issue.fields.assignee ? issue.fields.assignee.avatarUrls["32x32"] : null,
        issuetype: issue.fields.issuetype.name
    }
}

// Stringify credentials (with nonce), encrypt and return
function encryptCookie(credentials) {
    credentials.nonce = Array.from(new Uint8Array(require("crypto").randomBytes(16))).join("");
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
        ...config.jira,
        ...credentials
    })
    const user = await jira.getCurrentUser();
    if (!user) {
        throw new Error("Invalid credentials")
    }
    return jira;
}