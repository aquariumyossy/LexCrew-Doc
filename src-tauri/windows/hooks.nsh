!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /IM "${MAINBINARYNAME}.exe" /F'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GURI" '"$INSTDIR\${MAINBINARYNAME}.exe" --autostart'
  DeleteRegValue HKCU "Software\GURI" "StartAtLogin"
  Delete "$SMPROGRAMS\GURI\GURI.lnk"
  RMDir "$SMPROGRAMS\GURI"
  Delete "$DESKTOP\GURI.lnk"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /IM "${MAINBINARYNAME}.exe" /F'
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-hooks'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GURI"
  DeleteRegKey HKCU "Software\GURI"
  Delete "$SMPROGRAMS\GURI\GURI.lnk"
  RMDir "$SMPROGRAMS\GURI"
  Delete "$DESKTOP\GURI.lnk"
  Delete "$SMPROGRAMS\LexCrew Doc\LexCrew Doc.lnk"
  RMDir "$SMPROGRAMS\LexCrew Doc"
  Delete "$DESKTOP\LexCrew Doc.lnk"
!macroend
