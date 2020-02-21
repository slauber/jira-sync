let $resetBtn,
    $datepicker,
    $loginContainer,
    $loginRequired,
    $requestForm,
    $resultHeader,
    $resultBody,
    $resetButton,
    loggedIn;
$boardField = $("#boardId-field");
$datepicker = $("#datepicker");
$loginRequired = $(".loginRequired");
$resetButton = $("#reset-button");
$loginContainer = $("#login-container");
$requestForm = $("#request-form");
$resultHeader = $("#result-header");
$resultBody = $("#result-body");

// set loading overlay
$.LoadingOverlay("show");

// configure datepicker
$datepicker.datepicker({
    uiLibrary: "bootstrap4",
    format: "dd.mm.yyyy",
    value: dayjs()
        .subtract(1, "day")
        .format("DD.MM.YYYY")
});

// template for item entries
function generateEntry(item) {
    return `<div class="card mb-1">
            <div class="card-header">
              <span class="font-weight-bold">${item.key} (${
        item.issuetype
        })</span>: ${item.status} ${item.parent ? "(" + item.parent + ")" : ""}
            </div>
            <div class="card-body" .mb-n2>
              <p class="font-weight-normal">${item.summary}</p>
              <p class="font-weight-normal">${dayjs(item.updated).format(
            "DD.MM.YYYY"
        )}</p>
            </div>
          </div>`;
}

// check login and load boards
$(document).ready(function () {
    $.post("/check", null, response => {
        try {
            loggedIn = response.loggedIn;
        } catch (error) {
            console.log("Error checking login: " + error);
            $loginContainer.show();
            $loginRequired.hide();
        }
        if (loggedIn) {
            $loginContainer.hide();

            // load boards
            $.get("/getBoards", null, response => {
                try {
                    $boardField.select2({
                        data: response
                    });
                } catch (error) { }
            });
            $loginRequired.show();
        } else {
            $loginContainer.show();
            $loginRequired.hide();
        }
        $.LoadingOverlay("hide");
    });
});

// reset view
$resetButton.click(function (event) {
    event.preventDefault();
    $resultHeader.text("");
    $resultBody.html("");
});

// query tickets
$requestForm.submit(function (event) {
    event.preventDefault();
    $.LoadingOverlay("show");
    const post_url = $(this).attr("action");
    const form_data = $(this).serialize();
    $.post(post_url, form_data, function (response) {
        $.LoadingOverlay("hide");
        $resultHeader.text(
            "Changes of " +
            $boardField.select2("data")[0].text +
            " since " +
            $datepicker[0].value
        );

        const newTickets = [];
        const changedTickets = [];

        try {
            response = JSON.parse(response);
            for (item of response.newIssuesFormatted) {
                newTickets.push(generateEntry(item));
            }
            for (item of response.changedAndNotNewWithHistoryFiltered) {
                changedTickets.push(generateEntry(item));
            }
            $resultBody.html(
                '<h6 class="card-subtitle text-muted">' + response.sprintName + ": " + response.sprintGoal + '</h6>' +
                '<h6 class="card-subtitle text-muted mt-1">Total estimate: ' + response.estimateAll + ", Done: " + response.estimateDone + ", Open: " + response.estimateOpen + '</h6>' +
                '<h5 class="card-title mt-2">New tickets</h5>' +
                newTickets.join("\n") +
                '<h5 class="card-title mt-2">Changed tickets</h5>' +
                changedTickets.join("\n")
            );
        } catch (error) {
            console.log(error);
        }
    });
});