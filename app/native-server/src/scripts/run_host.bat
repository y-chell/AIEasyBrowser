@echo off
setlocal DisableDelayedExpansion

REM Chrome may not inherit the terminal PATH; build/register records the executable.
set "NODE_PATH_FILE=%~dp0node_path.txt"
set "NODE_SCRIPT=%~dp0index.js"

if not exist "%NODE_PATH_FILE%" (
    >&2 echo ERROR: Node.js path file not found: "%NODE_PATH_FILE%". Rebuild or register AIEasyBrowser.
    exit /B 1
)

set "NODE_EXEC="
for /f "usebackq delims=" %%N in ("%NODE_PATH_FILE%") do if not defined NODE_EXEC set "NODE_EXEC=%%N"
if not defined NODE_EXEC (
    >&2 echo ERROR: Node.js path file is empty: "%NODE_PATH_FILE%". Register AIEasyBrowser again.
    exit /B 1
)
if not exist "%NODE_EXEC%" (
    >&2 echo ERROR: Recorded Node.js executable not found: "%NODE_EXEC%". Register AIEasyBrowser again.
    exit /B 1
)
if exist "%NODE_EXEC%\*" (
    >&2 echo ERROR: Recorded Node.js path is a directory: "%NODE_EXEC%". Register AIEasyBrowser again.
    exit /B 1
)
if not exist "%NODE_SCRIPT%" (
    >&2 echo ERROR: Native host entrypoint not found: "%NODE_SCRIPT%". Rebuild AIEasyBrowser.
    exit /B 1
)

REM Keep the Native Messaging byte stream out of shell pipelines and log output.
"%NODE_EXEC%" "%NODE_SCRIPT%" %*
exit /B %ERRORLEVEL%
