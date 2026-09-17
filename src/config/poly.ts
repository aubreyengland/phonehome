function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Poly wants host + path without the scheme; serverType carries HTTPS separately. */
export function polyServerName(zoomUrl: string): string {
  return zoomUrl.replace(/^https?:\/\//i, '');
}

/** Master config (`{mac}.cfg`): only the per-MAC zoom file, nothing else. `macLower` is 12 hex chars. */
export function renderPolyMaster(macLower: string): string {
  return `<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="sip.ld" CONFIG_FILES="${macLower}-zoom.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY="" USER_PROFILES_DIRECTORY="" CALL_LISTS_DIRECTORY="" COREFILE_DIRECTORY=""/>
`;
}

/** `{mac}-zoom.cfg`: set the provisioning server to Zoom and stop using the DHCP boot server option. */
export function renderPolyDeviceConfig(zoomUrl: string): string {
  const serverName = escapeXmlAttr(polyServerName(zoomUrl));
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<polycomConfig>
  <device device.set="1" device.prov.serverType.set="1" device.prov.serverType="HTTPS" device.prov.serverName.set="1" device.prov.serverName="${serverName}" device.dhcp.bootSrvUseOpt.set="1" device.dhcp.bootSrvUseOpt="Static"/>
</polycomConfig>
`;
}
