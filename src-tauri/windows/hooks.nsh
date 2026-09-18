!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Windows にログインしたとき GURI を起動しますか？" IDYES +2
  Goto +2
  WriteRegStr HKCU "Software\GURI" "StartAtLogin" "1"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /IM "${MAINBINARYNAME}.exe" /F'
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-hooks'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GURI"
  DeleteRegKey HKCU "Software\GURI"
!macroend
