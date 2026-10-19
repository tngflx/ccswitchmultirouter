//! Takeover is a local trust boundary, not an authenticated LAN service.
use std::net::IpAddr;

pub(crate) const TAKEOVER_LOOPBACK_REQUIRED: &str = "Takeover listener must use a loopback address (127.0.0.1 or ::1). For LAN access, use the separate authenticated External API listener.";

pub(crate) fn parse_listener_ip(address: &str) -> Result<IpAddr, String> {
    let address = address.trim();
    if address == "localhost" {
        return Ok(IpAddr::from([127, 0, 0, 1]));
    }
    let literal = address
        .strip_prefix('[')
        .and_then(|a| a.strip_suffix(']'))
        .unwrap_or(address);
    let ip = literal
        .parse::<IpAddr>()
        .map_err(|_| "Listener address must be an IP literal or localhost".to_string())?;
    if literal != address && !ip.is_ipv6() {
        return Err("Only IPv6 listener addresses may use brackets".to_string());
    }
    Ok(ip)
}

pub(crate) fn takeover_listen_ip(address: &str) -> Result<IpAddr, String> {
    let ip = parse_listener_ip(address).map_err(|_| TAKEOVER_LOOPBACK_REQUIRED.to_string())?;
    // IpAddr deliberately does not classify IPv4-mapped IPv6 as loopback.
    // Do not add DNS resolution or permit hostnames here.
    if !ip.is_loopback() {
        return Err(TAKEOVER_LOOPBACK_REQUIRED.to_string());
    }
    Ok(ip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_accepts_only_literal_loopback_and_localhost() {
        for (address, expected) in [
            (" localhost ", "127.0.0.1"),
            ("127.255.255.255", "127.255.255.255"),
            ("[::1]", "::1"),
            ("0:0:0:0:0:0:0:1", "::1"),
        ] {
            assert_eq!(takeover_listen_ip(address).unwrap().to_string(), expected);
        }
        for address in [
            "0.0.0.0",
            "::",
            "[::]",
            "192.0.2.1",
            "2001:db8::1",
            "example.test",
            "localhost.example.test",
            "127.1",
            "127.00.0.1",
            "127.0.0.256",
            "2130706433",
            "0x7f000001",
            "::ffff:127.0.0.1",
            "::1%lo",
            "",
            "[127.0.0.1]",
        ] {
            assert!(takeover_listen_ip(address).is_err(), "{address}");
        }
    }

    #[test]
    fn authenticated_external_listener_can_parse_wildcard_and_ipv6() {
        assert_eq!(parse_listener_ip("0.0.0.0").unwrap().to_string(), "0.0.0.0");
        assert_eq!(parse_listener_ip("[::]").unwrap().to_string(), "::");
    }
}
