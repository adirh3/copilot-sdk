/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import net from "net";
import tls from "tls";

import forge from "node-forge";

export interface CaData {
  certPem: string;
  keyPem: string;
  caCert: forge.pki.Certificate;
  caKey: forge.pki.rsa.PrivateKey;
}

export function generateCA(): CaData {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";

  const now = new Date();
  const oneYearLater = new Date();
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  cert.validity.notBefore = now;
  cert.validity.notAfter = oneYearLater;

  const attrs: forge.pki.CertificateField[] = [
    { name: "commonName", value: "SDK E2E Test CA" },
    { name: "organizationName", value: "Copilot SDK Tests" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    caCert: cert,
    caKey: keys.privateKey,
  };
}

export interface IdentityData {
  certPem: string;
  keyPem: string;
}

export function createSecureContextForHost(
  hostname: string,
  ca: CaData,
): tls.SecureContext {
  const identity = createIdentityForHost(hostname, ca);
  return tls.createSecureContext({
    key: identity.keyPem,
    cert: identity.certPem,
    ca: ca.certPem,
  });
}

/**
 * Issues a CA-signed server identity for `hostname`. IP literals get an IP
 * subjectAltName rather than a DNS one, because verifiers reject a DNS name
 * when the client connected to an address; `serverAuth` and modern key-usage
 * extensions keep strict platform verifiers (macOS SecTrust) from rejecting
 * the chain outright.
 */
export function createIdentityForHost(
  hostname: string,
  ca: CaData,
): IdentityData {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());

  const now = new Date();
  const oneYearLater = new Date();
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  cert.validity.notBefore = now;
  cert.validity.notAfter = oneYearLater;

  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(ca.caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: net.isIP(hostname)
        ? [{ type: 7, ip: hostname }]
        : [{ type: 2, value: hostname }],
    },
    {
      name: "authorityKeyIdentifier",
      keyIdentifier: ca.caCert.generateSubjectKeyIdentifier().getBytes(),
    },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(ca.caKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}
