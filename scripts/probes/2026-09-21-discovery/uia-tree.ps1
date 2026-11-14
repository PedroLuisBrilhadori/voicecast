# Probe: UI Automation (UIA) tree of the foreground window — Windows
# equivalent of typesafe-computer-use's "accessibility tree walk" (macOS AX).
$ErrorActionPreference = "Stop"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { throw "no focused element" }
"focused element: $($focused.Current.ControlType.ProgrammaticName) | $($focused.Current.Name)"

# walk up to the top-level window
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$el = $focused
while ($true) {
  $p = $walker.GetParent($el)
  if ($null -eq $p -or $p -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
  $el = $p
}
$janela = $el.Current.Name
$procId = $el.Current.ProcessId
$proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
"window: '$janela' · pid=$procId ($proc)"

$t1 = [System.Diagnostics.Stopwatch]::StartNew()
$children = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
"descendants (ControlView): $($children.Count) nodes in $($t1.ElapsedMilliseconds)ms"

# how many have a name and an action pattern (Invoke/Value) — what matters to act on
$comNome = 0; $invocaveis = 0
$amostra = @()
foreach ($c in $children) {
  $n = $c.Current.Name
  if ($n) { $comNome++ }
  $hasInvoke = $false
  try { $hasInvoke = $null -ne $c.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}
  if ($hasInvoke) { $invocaveis++ }
  if ($amostra.Count -lt 20 -and $n) { $amostra += ("{0} | {1}{2}" -f $c.Current.ControlType.ProgrammaticName, $n, $(if ($hasInvoke) { " [Invoke]" } else { "" })) }
}
"with name: $comNome · invokable (InvokePattern): $invocaveis"
"--- sample (first 20 with name) ---"
$amostra
"total: $($sw.ElapsedMilliseconds)ms"
