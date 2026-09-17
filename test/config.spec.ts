import { describe, expect, it } from 'vitest';
import { renderYealinkRedirect } from '../src/config/yealink.ts';
import { polyServerName, renderPolyDeviceConfig, renderPolyMaster } from '../src/config/poly.ts';

describe('renderYealinkRedirect', () => {
  it('produces the exact redirect file', () => {
    expect(renderYealinkRedirect('https://provpp.zoom.us/api/v2/pbx/provisioning/yealink/t48s/')).toBe(
      `#!version:1.0.0.1
static.auto_provision.server.url = https://provpp.zoom.us/api/v2/pbx/provisioning/yealink/t48s/
static.auto_provision.dhcp_option.enable = 0
static.auto_provision.pnp_enable = 0
`,
    );
  });

  it('refuses a URL with a newline (config injection)', () => {
    expect(() => renderYealinkRedirect('https://x/\nstatic.security.user_password = pwn')).toThrow();
  });
});

describe('poly', () => {
  it('strips the scheme for device.prov.serverName', () => {
    expect(polyServerName('https://provpp.zoom.us/api/v2/pbx/provisioning/poly/vvx411/')).toBe('provpp.zoom.us/api/v2/pbx/provisioning/poly/vvx411/');
  });

  it('produces the master config referencing the per-MAC zoom file', () => {
    expect(renderPolyMaster('64167f4b6be7')).toBe(
      `<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="sip.ld" CONFIG_FILES="64167f4b6be7-zoom.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY="" USER_PROFILES_DIRECTORY="" CALL_LISTS_DIRECTORY="" COREFILE_DIRECTORY=""/>
`,
    );
  });

  it('produces the device config with XML-escaped server name', () => {
    expect(renderPolyDeviceConfig('https://provpp.zoom.us/p/?a=1&b=2')).toBe(
      `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<polycomConfig>
  <device device.set="1" device.prov.serverType.set="1" device.prov.serverType="HTTPS" device.prov.serverName.set="1" device.prov.serverName="provpp.zoom.us/p/?a=1&amp;b=2" device.dhcp.bootSrvUseOpt.set="1" device.dhcp.bootSrvUseOpt="Static"/>
</polycomConfig>
`,
    );
  });
});
