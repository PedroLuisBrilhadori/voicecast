# Probe: árvore UI Automation (UIA) da janela em primeiro plano — equivalente
# Windows do "accessibility tree walk" do typesafe-computer-use (macOS AX).
$ErrorActionPreference = "Stop"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { throw "sem elemento focado" }
"elemento focado: $($focused.Current.ControlType.ProgrammaticName) | $($focused.Current.Name)"

# sobe até a janela top-level
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
"janela: '$janela' · pid=$procId ($proc)"

$t1 = [System.Diagnostics.Stopwatch]::StartNew()
$children = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
"descendentes (ControlView): $($children.Count) nós em $($t1.ElapsedMilliseconds)ms"

# quantos têm nome e padrão de ação (Invoke/Value) — o que interessa p/ agir
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
"com nome: $comNome · invocáveis (InvokePattern): $invocaveis"
"--- amostra (20 primeiros com nome) ---"
$amostra
"total: $($sw.ElapsedMilliseconds)ms"
