$ErrorActionPreference = 'Continue'

Write-Host 'Restoring Windows power/sleep settings for AIcut training...'

powercfg /change standby-timeout-ac 1800
powercfg /change standby-timeout-dc 900
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /change monitor-timeout-ac 600
powercfg /change monitor-timeout-dc 300

Write-Host 'Restored: sleep AC=1800s, DC=900s; hibernate AC/DC=0; monitor AC=600s, DC=300s.'
