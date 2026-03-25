import {execFile} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

const temperatureScript = `
$temps = @()
try {
  $temps += Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop |
    Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU|Package|Tdie|Core Max' } |
    Select-Object -ExpandProperty Value
} catch {}
try {
  $temps += Get-WmiObject -Namespace root/OpenHardwareMonitor -Class Sensor -ErrorAction Stop |
    Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU|Package|Tdie|Core Max' } |
    Select-Object -ExpandProperty Value
} catch {}
try {
  $temps += Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
    ForEach-Object { ([math]::Round(($_.CurrentTemperature / 10) - 273.15, 1)) }
} catch {}
if ($temps.Count -gt 0) {
  ($temps | Measure-Object -Maximum).Maximum
}
`;

export const readCpuTemperatureC = async (): Promise<number | null> => {
  try {
    const {stdout} = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", temperatureScript],
      {windowsHide: true},
    );
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

export const waitForCpuCooling = async (
  limitC: number | null,
  cooldownMs: number,
  log: (message: string) => void,
): Promise<Array<number>> => {
  const samples: number[] = [];
  if (!limitC) {
    return samples;
  }

  while (true) {
    const temp = await readCpuTemperatureC();
    if (temp === null) {
      log("CPU temperature sensor is unavailable. Continuing without thermal throttling.");
      return samples;
    }

    samples.push(temp);
    if (temp <= limitC) {
      return samples;
    }

    log(`CPU temperature ${temp.toFixed(1)}C is above limit ${limitC.toFixed(1)}C. Cooling down for ${cooldownMs}ms.`);
    await delay(cooldownMs);
  }
};
