' Starts the TV Cast relay hidden and brings it back if it dies. Exit 0 = another copy already runs.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Do
  code = sh.Run("""C:\Program Files\nodejs\node.exe"" """ & dir & "\relay.js""", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 3000
Loop
