<#
gen-audio.ps1 - synthesize the word / example audio for the jp-vocab (Classroom Words) units.

ASCII ONLY on purpose: Windows PowerShell 5.1 decodes a BOM-less script as ANSI,
so any non-ASCII literal in here would turn into mojibake. Readings that differ
from the display form live in data.json as the optional "speak_word" field.

What it does
  for each unit dir that has a data.json:
    <unit>/audio/<id>-w.wav   <- card.speak_word, else card.word
    <unit>/audio/<id>-e.wav   <- card.example_jp
  Existing files are skipped unless -Force is given.

Voice / format (verified 2026-09-16 against the 126 wav already in the repo):
  Microsoft Haruka Desktop - Japanese, Rate -1, Volume 100, 22050 Hz 16-bit mono PCM.
  Haruka is the only ja-JP voice exposed through desktop SAPI; the OneCore voices
  (Ayumi / Ichiro / Sayaka) are not reachable from System.Speech or SAPI COM.
  SpeechAudioFormat default for that voice is exactly the format above, so no
  format is forced here.

Usage
  powershell -ExecutionPolicy Bypass -File jp-vocab\gen-audio.ps1
  powershell -ExecutionPolicy Bypass -File jp-vocab\gen-audio.ps1 -Unit igi-no-chikai-fukushi,kanji-ni-sonota-no-fukushi
  powershell -ExecutionPolicy Bypass -File jp-vocab\gen-audio.ps1 -OutRoot C:\tmp\stage -Force
#>
param(
  [string[]]$Unit,
  [string]$OutRoot = $PSScriptRoot,
  [int]$Rate = -1,
  [int]$Volume = 100,
  [string]$VoiceMatch = 'Haruka',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

$units = if ($Unit) { $Unit } else {
  Get-ChildItem -Path $PSScriptRoot -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'data.json') } |
    Select-Object -ExpandProperty Name
}
if (-not $units) { throw 'no unit dir with a data.json found' }

$voice = New-Object -ComObject SAPI.SpVoice
$tokens = $voice.GetVoices()
$picked = $null
$installed = @()
for ($i = 0; $i -lt $tokens.Count; $i++) {
  $d = $tokens.Item($i).GetDescription()
  $installed += $d
  if (-not $picked -and $d -like "*$VoiceMatch*") { $picked = $tokens.Item($i) }
}
if (-not $picked) { throw "no voice matching '$VoiceMatch'. installed: $($installed -join ' | ')" }
$voice.Voice = $picked
$voice.Rate = $Rate
$voice.Volume = $Volume

Write-Host ("voice  : " + $voice.Voice.GetDescription())
Write-Host ("rate   : $Rate    volume : $Volume")
Write-Host ("out    : $OutRoot")

$stream = New-Object -ComObject SAPI.SpFileStream
$made = 0
$skipped = 0
$warn = @()

foreach ($u in $units) {
  $jsonPath = Join-Path $PSScriptRoot (Join-Path $u 'data.json')
  if (-not (Test-Path $jsonPath)) { Write-Warning "skip $u : no data.json"; continue }
  $data = (Get-Content -Path $jsonPath -Encoding UTF8 -Raw) | ConvertFrom-Json
  $outAudio = Join-Path (Join-Path $OutRoot $u) 'audio'
  if (-not (Test-Path $outAudio)) { New-Item -ItemType Directory -Path $outAudio -Force | Out-Null }

  $unitMade = 0
  foreach ($cat in $data.categories) {
    foreach ($c in $cat.cards) {
      $wordText = if ($c.speak_word) { $c.speak_word } else { $c.word }
      if (-not $c.speak_word -and $c.word -match '[\uFF08\u30FB]') {
        $warn += "$u/$($c.id) : word contains a bracket or middle dot but has no speak_word -> spoken as written"
      }
      $jobs = @(
        @{ kind = 'w'; text = $wordText },
        @{ kind = 'e'; text = $c.example_jp }
      )
      foreach ($job in $jobs) {
        $out = Join-Path $outAudio ($c.id + '-' + $job.kind + '.wav')
        if ((Test-Path $out) -and -not $Force) { $skipped++; continue }
        $stream.Open($out, 3, $false)   # 3 = SSFMCreateForWrite
        $voice.AudioOutputStream = $stream
        $voice.Speak($job.text) | Out-Null
        $stream.Close()
        $made++
        $unitMade++
      }
    }
  }
  Write-Host ("  $u : $unitMade file(s)")
}

$stream = $null
Write-Host ("generated $made file(s), skipped $skipped")
if ($warn.Count) { Write-Host ''; $warn | ForEach-Object { Write-Warning $_ } }
