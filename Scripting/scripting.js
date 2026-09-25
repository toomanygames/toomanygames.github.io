const codeEditor =
    document.getElementById("codeEditor");

const lineNumbers =
    document.getElementById("lineNumbers");

const runButton =
    document.getElementById("runButton");

const clearButton =
    document.getElementById("clearButton");

const placeholder =
    document.getElementById("placeholder");

const previewStatus =
    document.getElementById("previewStatus");

const fullscreenPreviewButton =
    document.getElementById(
        "fullscreenPreviewButton"
    );

const previewContainer =
    document.querySelector(".preview");

const characterCount =
    document.getElementById("characterCount");

const gameTitle =
    document.getElementById("gameTitle");

const gameDescription =
    document.getElementById("gameDescription");

const gameAuthor =
    document.getElementById("gameAuthor");

const gameCategory =
    document.getElementById("gameCategory");

const publishButton =
    document.getElementById("publishButton");

const publishMessage =
    document.getElementById("publishMessage");

const published =
    document.getElementById("published");

const resultTitle =
    document.getElementById("resultTitle");

const resultDescription =
    document.getElementById("resultDescription");

const resultAuthor =
    document.getElementById("resultAuthor");

const resultCategory =
    document.getElementById("resultCategory");


/* =========================
   EDIT MODE
========================= */

const urlParams = new URLSearchParams(window.location.search);
const editGameId = urlParams.get("edit");
let editingGame = false;


async function loadGameForEditing() {
    if (!editGameId) return;

    try {
        const { data: { session }, error: sessionError } =
            await supabaseClient.auth.getSession();

        if (sessionError) {
            throw new Error(sessionError.message);
        }

        if (!session || !session.user) {
            return;
        }

        const { data: game, error } = await supabaseClient
            .from("community_games")
            .select(
                "id,title,description,author,category,code,creator_id"
            )
            .eq("id", editGameId)
            .eq("creator_id", session.user.id)
            .single();

        if (error || !game) {
            throw new Error(
                error?.message ||
                "That game could not be found or you do not own it."
            );
        }

        editingGame = true;

        gameTitle.value =
            game.title || "";

        gameDescription.value =
            game.description || "";

        gameCategory.value =
            game.category || "Other";

        gameAuthor.value =
            game.author ||
            gameAuthor.value;

        codeEditor.value =
            game.code || "";


        const heading =
            document.querySelector(".hero h1");

        const description =
            document.querySelector(".hero p");


        if (heading) {
            heading.textContent =
                "Edit Your Game";
        }

        if (description) {
            description.textContent =
                "Update your game, test your changes, and save them to DougHub.";
        }

        if (publishButton) {
            publishButton.textContent =
                "Save Changes";
        }


        updateEditor();
        runGame();


        if (publishMessage) {
            publishMessage.textContent =
                "Editing your published game.";

            publishMessage.style.color =
                "#a78bfa";
        }

    } catch (error) {

        console.error(
            "Could not load game for editing:",
            error
        );

        if (publishMessage) {

            publishMessage.textContent =
                error.message ||
                "Could not load that game.";

            publishMessage.style.color =
                "#ef4444";
        }
    }
}


let previewVersion = 0;

const COMMUNITY_GAME_WIDTH = 1280;
const COMMUNITY_GAME_HEIGHT = 720;


/* =========================
   PREVIEW SCALE
========================= */

function fitPreview() {

    const frame =
        document.getElementById(
            "gamePreview"
        );

    if (
        !frame ||
        !previewContainer
    ) {
        return;
    }


    const scale =
        Math.min(
            previewContainer.clientWidth /
                COMMUNITY_GAME_WIDTH,

            previewContainer.clientHeight /
                COMMUNITY_GAME_HEIGHT
        );


    const horizontalSpace =
        previewContainer.clientWidth -
        COMMUNITY_GAME_WIDTH * scale;


    const verticalSpace =
        previewContainer.clientHeight -
        COMMUNITY_GAME_HEIGHT * scale;


    frame.style.transform =
        `translate(${horizontalSpace / 2}px, ${verticalSpace / 2}px) scale(${scale})`;
}


/* =========================
   EDITOR
========================= */

function updateEditor() {

    if (!codeEditor) {
        return;
    }


    const code =
        codeEditor.value;

    const lines =
        code.split("\n");


    if (lineNumbers) {

        lineNumbers.innerHTML =
            "";


        for (
            let i = 1;
            i <= lines.length;
            i++
        ) {

            const line =
                document.createElement(
                    "div"
                );

            line.textContent =
                i;

            lineNumbers.appendChild(
                line
            );
        }
    }


    if (characterCount) {

        characterCount.textContent =
            `${code.length.toLocaleString()} characters`;
    }
}


/* =========================
   RUN GAME
========================= */

function runGame() {

    if (!codeEditor) {
        return;
    }


    const code =
        codeEditor.value;


    if (!code.trim()) {

        if (previewStatus) {

            previewStatus.textContent =
                "No code";
        }


        if (placeholder) {

            placeholder.style.display =
                "flex";
        }


        const frame =
            document.getElementById(
                "gamePreview"
            );


        if (frame) {

            frame.srcdoc =
                "";

            frame.style.display =
                "none";
        }

        return;
    }


    previewVersion++;


    const currentVersion =
        previewVersion;


    if (previewStatus) {

        previewStatus.textContent =
            "Loading...";
    }


    if (placeholder) {

        placeholder.style.display =
            "none";
    }


    const oldFrame =
        document.getElementById(
            "gamePreview"
        );


    const newFrame =
        document.createElement(
            "iframe"
        );


    newFrame.id =
        "gamePreview";


    newFrame.title =
        "Game Preview";


    newFrame.setAttribute(
        "scrolling",
        "no"
    );

    newFrame.setAttribute(
        "sandbox",
        "allow-scripts"
    );


    if (oldFrame) {

        oldFrame.replaceWith(
            newFrame
        );
    }


    fitPreview();


    requestAnimationFrame(
        function() {

            if (
                currentVersion !==
                previewVersion
            ) {
                return;
            }


            newFrame.srcdoc =
                code;
        }
    );


    newFrame.onload =
        function() {

            if (
                currentVersion ===
                previewVersion
            ) {

                if (previewStatus) {

                    previewStatus.textContent =
                        "Running";
                }
            }
        };
}


/* =========================
   CLEAR
========================= */

function clearCode() {

    if (
        !confirm(
            "Clear all game code?"
        )
    ) {
        return;
    }


    previewVersion++;


    codeEditor.value =
        "";


    const frame =
        document.getElementById(
            "gamePreview"
        );


    if (frame) {

        frame.srcdoc =
            "";

        frame.style.display =
            "none";
    }


    if (placeholder) {

        placeholder.style.display =
            "flex";
    }


    if (previewStatus) {

        previewStatus.textContent =
            "Waiting";
    }


    updateEditor();


    codeEditor.focus();
}


/* =========================
   PUBLISH / UPDATE
========================= */

async function publishGame() {

    const title =
        gameTitle.value.trim();


    const description =
        gameDescription.value.trim();


    const author =
        gameAuthor.value.trim() ||
        "Anonymous";


    const category =
        gameCategory.value;


    const code =
        codeEditor.value.trim();


    publishMessage.textContent =
        "";


    publishMessage.style.color =
        "";


    /* TITLE */

    if (!title) {

        publishMessage.textContent =
            "Please enter a game title.";

        return;
    }


    /* CODE */

    if (!code) {

        publishMessage.textContent =
            "Please add some game code first.";

        return;
    }


    /* SIZE */

    if (
        code.length >
        500000
    ) {

        publishMessage.textContent =
            "Your game code is too large.";

        return;
    }


    publishButton.disabled =
        true;


    publishButton.textContent =
        editingGame
            ? "Saving..."
            : "Publishing...";


    try {

        /*
          Use the Supabase client
          already created in
          scripting.html.
        */

        if (
            typeof supabaseClient ===
            "undefined"
        ) {

            throw new Error(
                "Supabase is not loaded."
            );
        }


        const {
            data: {
                session
            },
            error: sessionError
        } =
            await supabaseClient.auth.getSession();


        if (sessionError) {

            throw new Error(
                sessionError.message
            );
        }


        if (
            !session ||
            !session.user
        ) {

            throw new Error(
                "You must be logged in to publish a game."
            );
        }


        /*
          Publish a new game
          OR update an existing game.
        */

        let data;
        let error;


        if (
            editingGame &&
            editGameId
        ) {

            const result =
                await supabaseClient
                    .from(
                        "community_games"
                    )
                    .update({

                        title:
                            title,

                        description:
                            description,

                        author:
                            author,

                        category:
                            category,

                        code:
                            code

                    })
                    .eq(
                        "id",
                        editGameId
                    )
                    .eq(
                        "creator_id",
                        session.user.id
                    )
                    .select()
                    .single();


            data =
                result.data;

            error =
                result.error;


        } else {

            const result =
                await supabaseClient
                    .from(
                        "community_games"
                    )
                    .insert({

                        title:
                            title,

                        description:
                            description,

                        author:
                            author,

                        category:
                            category,

                        code:
                            code,

                        creator_id:
                            session.user.id

                    })
                    .select()
                    .single();


            data =
                result.data;

            error =
                result.error;
        }


        if (error) {

            console.error(
                "Supabase error:",
                error
            );


            throw new Error(
                error.message ||
                "Could not publish the game."
            );
        }


        /* =========================
           SHOW RESULT
        ========================= */

        resultTitle.textContent =
            data.title;


        resultDescription.textContent =
            data.description ||
            "No description.";


        resultAuthor.textContent =
            data.author ||
            "Anonymous";


        resultCategory.textContent =
            data.category ||
            "Other";


        published.style.display =
            "block";


        publishMessage.textContent =
            editingGame
                ? "Game updated successfully!"
                : "Game published successfully!";


        publishMessage.style.color =
            "#22c55e";


        published.scrollIntoView({
            behavior: "smooth",
            block: "center"
        });


    } catch (error) {

        console.error(
            "Publish error:",
            error
        );


        publishMessage.textContent =
            error.message ||
            "Could not publish the game.";


        publishMessage.style.color =
            "#ef4444";


    } finally {

        publishButton.disabled =
            false;


        publishButton.textContent =
            editingGame
                ? "Save Changes"
                : "Publish Game";
    }
}


/* =========================
   EVENTS
========================= */

if (codeEditor) {

    /*
      Typing
    */

    codeEditor.addEventListener(
        "input",
        updateEditor
    );


    /*
      Scroll line numbers
    */

    codeEditor.addEventListener(
        "scroll",
        function() {

            if (lineNumbers) {

                lineNumbers.scrollTop =
                    codeEditor.scrollTop;
            }
        }
    );


    /*
      Keyboard controls
    */

    codeEditor.addEventListener(
        "keydown",
        function(event) {


            /* TAB */

            if (
                event.key ===
                "Tab"
            ) {

                event.preventDefault();


                const start =
                    codeEditor.selectionStart;


                const end =
                    codeEditor.selectionEnd;


                codeEditor.value =
                    codeEditor.value.substring(
                        0,
                        start
                    ) +
                    "    " +
                    codeEditor.value.substring(
                        end
                    );


                codeEditor.selectionStart =
                    start + 4;


                codeEditor.selectionEnd =
                    start + 4;


                updateEditor();
            }


            /* CTRL + ENTER */

            if (
                (
                    event.ctrlKey ||
                    event.metaKey
                ) &&
                event.key.toLowerCase() ===
                "enter"
            ) {

                event.preventDefault();

                runGame();
            }

        }
    );

}


/* =========================
   RUN BUTTON
========================= */

if (runButton) {

    runButton.addEventListener(
        "click",
        runGame
    );
}


/* =========================
   CLEAR BUTTON
========================= */

if (clearButton) {

    clearButton.addEventListener(
        "click",
        clearCode
    );
}


/* =========================
   FULLSCREEN PREVIEW
========================= */

function updateFullscreenButton() {

    if (
        !fullscreenPreviewButton
    ) {
        return;
    }


    const isFullscreen =
        document.fullscreenElement ===
        previewContainer;


    fullscreenPreviewButton.textContent =
        isFullscreen
            ? "Exit Fullscreen"
            : "⛶ Fullscreen";
}


if (
    fullscreenPreviewButton &&
    previewContainer
) {

    fullscreenPreviewButton.addEventListener(
        "click",
        async function() {

            try {

                if (
                    document.fullscreenElement ===
                    previewContainer
                ) {

                    await document.exitFullscreen();

                } else {

                    await previewContainer.requestFullscreen();
                }

            } catch (error) {

                console.error(
                    "Could not change preview fullscreen mode:",
                    error
                );


                if (previewStatus) {

                    previewStatus.textContent =
                        "Fullscreen is unavailable";
                }
            }
        }
    );


    document.addEventListener(
        "fullscreenchange",
        function() {

            updateFullscreenButton();

            fitPreview();
        }
    );
}


window.addEventListener(
    "resize",
    fitPreview
);


/* =========================
   PUBLISH BUTTON
========================= */

if (publishButton) {

    publishButton.addEventListener(
        "click",
        publishGame
    );
}


/* =========================
   START
========================= */

updateEditor();

loadGameForEditing();