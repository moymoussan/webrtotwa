# WhatsApp → Twilio SIP Gateway

This repository contains a simple SIP gateway written in Node.js that bridges incoming **WhatsApp Business Calling API** calls (delivered via SIP) to a **Twilio SIP Domain**. The gateway rewrites the session description (SDP) to use codecs that Twilio supports (PCMU/PCMA), forwards the call to your Twilio domain, and signs requests with digest authentication so Twilio can verify the call. Once Twilio accepts the call it will invoke the Voice webhook you have configured for your SIP Domain (for example the n8n webhook shown in your setup).

## How it works

* The gateway listens for SIP `INVITE` requests on a configurable port (`PORT`). WhatsApp/Meta is configured to send SIP calls to this gateway instead of directly to Twilio.
* When an `INVITE` is received the gateway:
  1. Parses the SDP and removes unsupported codecs, leaving only **G.711 µ‑law (PCMU)**, **G.711 A‑law (PCMA)** and **telephone‑event (DTMF)**.
  2. Rewrites the request URI and `To` header to point at your Twilio SIP Domain (`TWILIO_SIP_DOMAIN`) and destination user/number (`TWILIO_DESTINATION`).
  3. Forwards the modified request to Twilio. If Twilio responds with a 401/407 challenge, the gateway automatically signs the request using the credentials defined in `TWILIO_SIP_USERNAME` and `TWILIO_SIP_PASSWORD`.
  4. Responses from Twilio are proxied back to the original caller.
* The gateway does **not** enforce authentication on inbound calls from WhatsApp/Meta. You should restrict access at your firewall or edge proxy. Optionally you can enable TLS on the listening port by providing a certificate and private key and setting `USE_TLS=true`.

## Prerequisites

1. **Node.js 16+** – the gateway is written in Node.js and uses ES2019+ features.
2. **WhatsApp Business Calling enabled** – your WhatsApp phone number must have calling enabled and configured for SIP. You can obtain the SIP user/password by calling the settings endpoint with `include_sip_credentials=true`.
3. **Twilio SIP Domain** – create a SIP Domain in your Twilio console and configure its **Voice URL** to point at your IVR or workflow (e.g. your n8n webhook).
4. **Twilio Credential List** – create a credential list in Twilio containing a username and password (this will be your `TWILIO_SIP_USERNAME` and `TWILIO_SIP_PASSWORD`) and assign it to your SIP Domain to enforce authentication on inbound calls.
5. **DNS / TLS** – Meta requires TLS when sending SIP calls. You should either terminate TLS at a load‑balancer/reverse proxy in front of this gateway or supply a certificate and key via `TLS_CERT_PATH` and `TLS_KEY_PATH` and set `USE_TLS=true`.

## Configuration

Copy `.env.example` to `.env` and update the values to suit your deployment. The most important variables are:

| Variable | Description |
|---|---|
| `PORT` | Port to listen for SIP traffic (default 5060). |
| `META_SIP_USERNAME` | The phone_number_id from the WhatsApp Business Cloud API. |
| `META_SIP_PASSWORD` | SIP password retrieved via `include_sip_credentials=true`. |
| `TWILIO_SIP_USERNAME` | Username from your Twilio Credential List. |
| `TWILIO_SIP_PASSWORD` | Password from your Twilio Credential List. |
| `TWILIO_SIP_DOMAIN` | Your Twilio SIP Domain (e.g. `nonocard.sip.twilio.com`). |
| `TWILIO_DESTINATION` | Destination user/number to dial at Twilio (e.g. `+5215541655565`). |
| `WEBHOOK_URL` | Voice URL configured on the Twilio SIP Domain (unused by the gateway but documented for reference). |
| `USE_TLS` | Set to `true` to enable TLS transport (default `false`). |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | Paths to your certificate and private key when `USE_TLS=true`. |

## Running locally

1. Install dependencies:

```
npm install
```

2. Copy the `.env.example` to `.env` and update the values:

```
cp .env.example .env
```

3. Start the gateway:

```
npm start
```

The server will log incoming calls and forward them to Twilio. You should see 401/407 challenges from Twilio followed by 200 OK once the call is authenticated and connected.

## Deploying to Railway

Railway can automatically detect a Node.js project and run it. To deploy:

1. Create a new Railway project and connect this repository.
2. Set the environment variables in Railway to match your `.env` values.
3. Optionally add a `Procfile` containing `web: npm start` so the gateway starts automatically.
4. Expose the port Railway assigns (the `PORT` env var will automatically override the default).

Once deployed you can configure the WhatsApp SIP settings to point at `<gateway-domain>:PORT` (over TLS if configured) instead of your Twilio SIP Domain. Calls will then be relayed to Twilio through this gateway.

## Security considerations

This gateway intentionally does **not** authenticate inbound requests from WhatsApp/Meta. You should implement one or more of the following security measures in production:

* Restrict the source IPs allowed to connect (either via firewall or the Twilio SIP Domain Access Control List if you remove this gateway and point Meta directly at Twilio).
* Enable TLS transport (`USE_TLS=true`) and use a valid certificate matching the hostname you configure in WhatsApp.
* Inspect the `From` header or other parts of the SIP request to reject unauthorized callers.

## Disclaimer

This code is provided as a reference implementation and may not handle every edge case (e.g. media negotiation, in‑dialog requests, re‑INVITEs, etc.). Use it as a starting point and adapt it to your needs.