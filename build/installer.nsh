; Extra NSIS behaviour for the installer.
;
; On uninstall, offer to remove the data this app created in AppData: settings
; and the cache of prepared clips and thumbnails. Only that one folder is
; touched. Recordings, screenshots and anything belonging to Steam are left
; exactly as they are.

!macro customUnInstall
  ; Skip the prompt when the uninstaller runs as part of an update.
  ${ifNot} ${isUpdated}
    ; Guard against a malformed path before recursively deleting anything.
    StrCpy $0 "$APPDATA\${APP_FILENAME}"
    ${if} ${FileExists} "$0\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Also remove ${PRODUCT_NAME} settings and cached clips?$\n$\n\
        This deletes only:$\n$0$\n$\n\
        Your Steam recordings and screenshots are not touched." \
        /SD IDNO IDYES removeAppData IDNO keepAppData
      removeAppData:
        RMDir /r "$0"
      keepAppData:
    ${endIf}
  ${endIf}
!macroend
