# Sets the /developer login on the production server in one go.
# Usage (PowerShell, project root):  .\scripts\set-server-developer-password.ps1
# It asks for the password, hashes it locally (scrypt) and sends ONLY the hash.
$ErrorActionPreference = "Stop"
$key = Join-Path $env:USERPROFILE "Downloads\AppleShop.pem"
$server = "ubuntu@32.199.91.62"
$email = "jamolxonyoldashaliyev3@gmail.com"

$secure = Read-Host "Yangi developer parol (kamida 8 belgi)" -AsSecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ($password.Length -lt 8) { throw "Parol kamida 8 belgi bo'lsin" }

$hash = (node scripts/hash-developer-password.mjs $password).Trim()
if ($hash -notmatch '^[0-9a-f]{32}:[0-9a-f]{128}$') { throw "Hesh noto'g'ri chiqdi" }

$remote = "cd ~/socialauto && sed -i '/^DEVELOPER_EMAIL=/d;/^DEVELOPER_PASSWORD_HASH=/d' .env && printf 'DEVELOPER_EMAIL=$email\nDEVELOPER_PASSWORD_HASH=$hash\n' >> .env && APP_TAG=f73d927df05e4c43bc96585dc460af32de9ff022 docker compose -f docker-compose.server.yml up -d --force-recreate --no-deps web"
ssh -i $key $server $remote
Write-Host "Tayyor. /developer ga email: $email va yangi parol bilan kiring."
