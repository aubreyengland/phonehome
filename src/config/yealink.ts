/**
 * Minimal Yealink auto-provision file: point the phone at Zoom, drop the credentials its
 * previous provisioning server left behind, and stop it from asking PnP again on the next
 * boot (which would bring it straight back here). DHCP option lookup stays enabled, so a
 * phone that boots on a network handing out option 66 takes the server the DHCP scope
 * names over the URL written here.
 *
 * The blank username and password are load-bearing, not tidiness. A RingCentral-provisioned
 * phone still holds RC's provisioning credentials, presents them to Zoom, and Zoom's assisted
 * provisioning refuses it. Zoom's own Yealink procedure says to clear both fields by hand;
 * these two lines do it for every phone instead. Both parameters default to blank, so a blank
 * value resets them.
 */
export function renderYealinkRedirect(zoomUrl: string): string {
  if (/[\r\n]/.test(zoomUrl)) {
    throw new Error('zoomUrl must be a single line');
  }
  return `#!version:1.0.0.1
static.auto_provision.server.url = ${zoomUrl}
static.auto_provision.server.username =
static.auto_provision.server.password =
static.auto_provision.dhcp_option.enable = 1
static.auto_provision.pnp_enable = 0
`;
}
