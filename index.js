// Whatsapp → Twilio SIP Gateway
//
// This gateway accepts SIP INVITE requests from the WhatsApp Business Calling API
// (via 360dialog or Meta directly), rewrites the SDP to match Twilio's
// supported codecs and forwards the call to your Twilio SIP Domain.  It
// performs digest authentication against Twilio using the credentials supplied
// in the environment.  It does not enforce authentication on inbound
// requests but you can enable TLS and restrict the source IP at the network
// level.  Responses from Twilio are automatically proxied back to the caller.

require('dotenv').config();

const sip = require('sip');
const proxy = require('sip/proxy');
const digest = require('sip/digest');
const sdpTransform = require('sdp-transform');
const fs = require('fs');

// Load configuration from environment
const PORT = Number(process.env.PORT) || 5060;
const USE_TLS = (process.env.USE_TLS || '').toLowerCase() === 'true';
const META_USER = process.env.META_SIP_USERNAME || '';
const META_PASS = process.env.META_SIP_PASSWORD || '';
const TWILIO_USER = process.env.TWILIO_SIP_USERNAME || '';
const TWILIO_PASS = process.env.TWILIO_SIP_PASSWORD || '';
const TWILIO_DOMAIN = process.env.TWILIO_SIP_DOMAIN || '';
const TWILIO_DEST = process.env.TWILIO_DESTINATION || '';

// Session for digest auth when talking to Twilio
const sessionTwilio = {};
const credentialsTwilio = {
  user: TWILIO_USER,
  realm: 'sip.twilio.com',
  password: TWILIO_PASS
};

// Start proxy.  Configure transports based on TLS flag.
const proxyOptions = {
  port: PORT,
  udp: true,
  tcp: true
};

if (USE_TLS) {
  proxyOptions.tls = {
    // Node's TLS options; load cert and key from the paths defined in the env.
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    cert: fs.readFileSync(process.env.TLS_CERT_PATH)
  };
  proxyOptions.tls_port = PORT;
}

console.log(`[gateway] Starting SIP gateway on port ${PORT} (${USE_TLS ? 'TLS' : 'UDP/TCP'})`);

// Helper to rewrite SDP to ensure Twilio-compatible codecs (G.711 µlaw/alaw).
function rewriteSdp(sdp) {
  try {
    const parsed = sdpTransform.parse(sdp);
    parsed.media = parsed.media.map(media => {
      if (media.type === 'audio') {
        // Only allow PCMU (0) and PCMA (8) and telephone-event (101)
        const allowedPayloads = [0, 8, 101];
        media.payloads = allowedPayloads.join(' ');
        // filter out rtp lines
        media.rtp = media.rtp.filter(r => allowedPayloads.includes(r.payload));
        // ensure telephone-event present
        if (!media.rtp.find(r => r.payload === 101)) {
          media.rtp.push({ payload: 101, codec: 'telephone-event', rate: 8000 });
        }
        // filter fmtp or add fmtp for telephone-event
        media.fmtp = (media.fmtp || []).filter(f => allowedPayloads.includes(parseInt(f.payload)));
        if (!media.fmtp.find(f => parseInt(f.payload) === 101)) {
          media.fmtp.push({ payload: 101, config: '0-16' });
        }
        // Remove unsupported attributes
        media.rtcp = undefined;
      }
      return media;
    });
    return sdpTransform.write(parsed);
  } catch (err) {
    console.warn('[gateway] Failed to parse SDP:', err);
    return sdp;
  }
}

// Start the proxy
proxy.start(proxyOptions, function onIncomingRequest(rq) {
  try {
    if (rq.method === 'INVITE') {
      console.log(`[gateway] Received INVITE from ${rq.headers.from && rq.headers.from.uri}`);
      // Modify SDP body if present
      if (rq.content) {
        const newSdp = rewriteSdp(rq.content);
        rq.content = newSdp;
        rq.headers['content-length'] = Buffer.byteLength(newSdp).toString();
      }
      // Build the Twilio destination SIP URI
      const destUri = `sip:${TWILIO_DEST}@${TWILIO_DOMAIN}`;
      rq.uri = destUri;
      // Update To header
      if (rq.headers.to) {
        rq.headers.to.uri = destUri;
      } else {
        rq.headers.to = { uri: destUri };
      }
      // Optionally update Contact header to reflect this gateway
      // (Not strictly necessary for proxying)
      rq.headers.contact = [{ uri: `sip:${META_USER}@${process.env.PUBLIC_IP || 'example.com'}` }];

      // Forward to Twilio.  Provide callback to handle challenges.
      proxy.send(rq, function defaultProxyCallback(rs) {
        // Remove top Via (proxy will do this for us normally)
        // In case of challenge, sign and resend
        if (rs.status === 401 || rs.status === 407) {
          console.log('[gateway] Received challenge from Twilio, signing request...');
          digest.signRequest(sessionTwilio, rq, rs, credentialsTwilio);
          proxy.send(rq);
          return;
        }
        // Forward other responses back to the original caller
        proxy.send(rs);
      });
    } else if (rq.method === 'ACK' || rq.method === 'CANCEL' || rq.method === 'BYE' || rq.method === 'PRACK' || rq.method === 'UPDATE') {
      // For in-dialog requests, simply proxy them to the other side
      proxy.send(rq);
    } else {
      // Respond with Method Not Allowed for other methods
      proxy.send(sip.makeResponse(rq, 405, 'Method Not Allowed'));
    }
  } catch (err) {
    console.error('[gateway] Error processing request:', err);
    proxy.send(sip.makeResponse(rq, 500, 'Server Error'));
  }
});