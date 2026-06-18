; Custom electron-builder NSIS hooks (auto-included from build/installer.nsh).
;
; Override the default "is the app running?" check. electron-builder's default
; (templates/nsis/include/allowOnlyOneInstallerInstance.nsh → _CHECK_APP_RUNNING)
; finds ${APP_EXECUTABLE_FILENAME} via tasklist, tries taskkill, and if the kill
; doesn't clear it, dead-ends on a "Sibyl cannot be closed" RETRY/CANCEL prompt.
;
; Two things trip that prompt for Sibyl even when no window is open:
;   1. A GPU/CUDA teardown crash (0xC0000409) can leave a *zombie* Sibyl.exe that
;      lingers in Task Manager and resists a plain taskkill.
;   2. A second install (allowToChangeInstallationDirectory) leaves another
;      Sibyl.exe image the default per-user check still matches.
; During an auto-update the installer then blocks instead of proceeding.
;
; Replacement: politely ask the app to close, then force-kill the whole Sibyl.exe
; process *tree* (/T also takes its GPU/llama worker children), and continue
; without ever prompting. Inserted for both the installer and the uninstaller.
!macro customCheckAppRunning
  ; 1) Graceful close (WM_CLOSE to GUI processes), then a moment to exit.
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 800
  ; 2) Force-kill any survivors plus their child process tree (GPU/llama workers).
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  ; 3) Let Windows + the GPU driver release file/device handles before we overwrite.
  Sleep 1200
!macroend
