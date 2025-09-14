import { WebRTC, WebSockets, WebSocketsSecure, WebTransport, Circuit, WebRTCDirect } from '@multiformats/multiaddr-matcher'

export function listAddresses(libp2p) {
  return libp2p.getMultiaddrs().map(ma => ma.toString())
}
export function countPeerTypes(libp2p) {
  const t = { 'Circuit Relay': 0, WebRTC: 0, 'WebRTC Direct': 0, WebSockets: 0, 'WebSockets (secure)': 0, WebTransport: 0, Other: 0 }
  libp2p.getConnections().map(c => c.remoteAddr).forEach((ma) => {
    if (WebRTC.exactMatch(ma)) t['WebRTC']++
    else if (WebRTCDirect.exactMatch(ma)) t['WebRTC Direct']++
    else if (WebSockets.exactMatch(ma)) t['WebSockets']++
    else if (WebSocketsSecure.exactMatch(ma)) t['WebSockets (secure)']++
    else if (WebTransport.exactMatch(ma)) t['WebTransport']++
    else if (Circuit.exactMatch(ma)) t['Circuit Relay']++
    else t['Other']++
  })
  return t
}
export function peerDetails(libp2p) {
  return libp2p.getPeers().map(peer => {
    const conns = libp2p.getConnections(peer)
    return { id: peer.toString(), addrs: conns.map(c => c.remoteAddr.toString()) }
  })
}

