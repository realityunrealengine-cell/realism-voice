; Realism Voice NSIS additions.
;
; App-running check without PowerShell. electron-builder's default check runs PowerShell (Get-CimInstance)
; and on failure shows "cannot close Realism Voice". Under Wine (Linux), with policies blocking PowerShell or
; with a broken PowerShell the installer could not continue. nsProcess uses Windows APIs directly;
; if the process cannot be found, installation simply continues.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${if} ${isUpdated}

      Sleep 2000
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${endIf}
  ${endIf}
  ${if} $R0 == 0
    ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 1500
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      Sleep 1000
    ${endIf}
  ${endIf}
  ${nsProcess::Unload}
!macroend
