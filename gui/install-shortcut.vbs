Set ws = CreateObject("WScript.Shell")
desktop = ws.SpecialFolders("Desktop")
Set sc = ws.CreateShortcut(desktop & "\AIcut.lnk")
sc.TargetPath = "E:\AIcut\gui\start.bat"
sc.WorkingDirectory = "E:\AIcut\gui"
sc.Description = "AIcut - AI Video Editor"
sc.IconLocation = "imageres.dll,67"
sc.WindowStyle = 7
sc.Save()
MsgBox "AIcut shortcut created on Desktop!", 64, "AIcut"
