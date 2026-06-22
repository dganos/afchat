; Custom install step for Aristo.
;
; The model store (~5 GB) is NOT bundled inside this installer (that would make a
; 5 GB .exe that can't be uploaded to GitHub Releases, 2 GB/file limit). Instead it
; ships next to the installer as split parts:
;     Aristo-Setup-<ver>.exe
;     Aristo-Windows-models.zip.part00, .part01, ...
; At install time we concatenate the parts (copy /b, in name order) back into the
; original zip and extract it into <install>\resources\models using the tar.exe that
; ships with Windows 10/11. No NSIS plugin or admin rights required.

!macro customInstall
  IfFileExists "$EXEDIR\Aristo-Windows-models.zip.part00" 0 noParts
    DetailPrint "Assembling Aristo model from split parts..."
    nsExec::ExecToLog 'cmd /c copy /b "$EXEDIR\Aristo-Windows-models.zip.part*" "$PLUGINSDIR\models.zip"'
    Pop $0
    IfFileExists "$PLUGINSDIR\models.zip" 0 mergeFailed
    CreateDirectory "$INSTDIR\resources\models"
    IfFileExists "$SYSDIR\tar.exe" 0 noTar
      DetailPrint "Extracting model into $INSTDIR\resources\models (this can take a few minutes)..."
      nsExec::ExecToLog '"$SYSDIR\tar.exe" -xf "$PLUGINSDIR\models.zip" -C "$INSTDIR\resources\models"'
      Pop $0
      Delete "$PLUGINSDIR\models.zip"
      IfFileExists "$INSTDIR\resources\models\blobs\*.*" done extractFailed
    extractFailed:
      MessageBox MB_ICONEXCLAMATION "Aristo: model extraction failed. The app will start without a model until resources\models is populated."
      Goto done
    noTar:
      MessageBox MB_ICONEXCLAMATION "Aristo: Windows tar.exe was not found, so the model could not be extracted automatically. Windows 10 (1803+) or 11 is required."
      Goto done
    mergeFailed:
      MessageBox MB_ICONEXCLAMATION "Aristo: could not assemble the model parts. Make sure all Aristo-Windows-models.zip.partNN files are in the same folder as this installer."
      Goto done
  noParts:
    MessageBox MB_ICONEXCLAMATION "Aristo model parts were not found next to the installer.$\r$\nKeep the Aristo-Windows-models.zip.partNN files in the SAME folder as this installer, then run it again.$\r$\nThe app is installed but will have no model until then."
  done:
!macroend
