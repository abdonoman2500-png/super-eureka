// End-to-end smoke test of the NimbusVault API contract.
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";

let jar = new Map();

async function call(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof Uint8Array)
        ? { "content-type": "application/json" }
        : {}),
      ...(init.headers ?? {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return res;
}

const assert = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const randomEmail = `tester${Date.now()}@example.com`;

// 1. register
const reg = await call("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    email: randomEmail,
    password: "SuperSecret1!",
    pin: "482913",
    keyWrapSalt: "c2FsdA",
    encryptedKeyBlob: "YmxvYg",
    keyWrapIv: "aXY",
  }),
});
assert(reg.status === 201, `register -> ${reg.status}`);

// 2. PIN unlock
const pin = await call("/api/auth/pin", {
  method: "POST",
  body: JSON.stringify({ pin: "482913" }),
});
assert(pin.ok, `pin verify -> ${pin.status}`);

const badPin = await call("/api/auth/pin", {
  method: "POST",
  body: JSON.stringify({ pin: "000000" }),
});
assert(badPin.status === 401, `wrong pin rejected -> ${badPin.status}`);

// restore valid unlock
await call("/api/auth/pin", { method: "POST", body: JSON.stringify({ pin: "482913" }) });

// 3. create folder
const folder = await call("/api/vault", {
  method: "POST",
  body: JSON.stringify({ name: "الصور" }),
});
const folderJson = await folder.json();
assert(folder.status === 201 && folderJson.folder.id, "folder created");

// 4. single-part upload
const single = await call("/api/uploads", {
  method: "POST",
  body: JSON.stringify({
    fileName: "note.txt",
    size: 100,
    mimeType: "text/plain",
    folderId: folderJson.folder.id,
  }),
});
const singleInit = await single.json();
assert(singleInit.mode === "single" && singleInit.putUrl, "single-part presign issued");

const payload = new Uint8Array(128); // 100 plaintext + 28 GCM overhead
crypto.getRandomValues(payload);
const putRes = await fetch(BASE + singleInit.putUrl, {
  method: "PUT",
  body: payload,
});
assert(putRes.ok, `direct PUT -> ${putRes.status}`);

const complete = await call(`/api/uploads/${singleInit.uploadId}/complete`, {
  method: "POST",
  body: JSON.stringify({
    parts: [{ partNumber: 1, etag: "abc", size: 128 }],
    width: 10,
    height: 10,
  }),
});
const completeJson = await complete.json();
assert(complete.ok && completeJson.file, `complete -> ${complete.status}`);
assert(completeJson.storedBytes === 128, `storedBytes = ${completeJson.storedBytes}`);

// 5. multipart upload (2 parts)
const mp = await call("/api/uploads", {
  method: "POST",
  body: JSON.stringify({
    fileName: "clip.mp4",
    size: 8 * 1024 * 1024 + 5,
    mimeType: "video/mp4",
    folderId: null,
  }),
});
const mpInit = await mp.json();
assert(
  mpInit.mode === "multipart" && mpInit.partUrls.length === 2,
  `multipart urls = ${mpInit.partUrls?.length}`,
);
for (let i = 0; i < mpInit.partUrls.length; i += 1) {
  const part = new Uint8Array(8 * 1024 * 1024 + 28 - (i === 1 ? 8 * 1024 * 1024 - 5 : 0));
  const r = await fetch(BASE + mpInit.partUrls[i], { method: "PUT", body: part });
  assert(r.ok, `part ${i + 1} PUT -> ${r.status}`);
}
const mpComplete = await call(`/api/uploads/${mpInit.uploadId}/complete`, {
  method: "POST",
  body: JSON.stringify({
    parts: [
      { partNumber: 1, etag: "p1", size: 8 * 1024 * 1024 + 28 },
      { partNumber: 2, etag: "p2", size: 33 },
    ],
  }),
});
const mpJson = await mpComplete.json();
assert(mpComplete.ok && mpJson.storedBytes === 8 * 1024 * 1024 + 61, `mpu stored = ${mpJson.storedBytes}`);

// 6. listing
const vault = await call("/api/vault");
const vaultJson = await vault.json();
assert(vault.ok && vaultJson.files.length === 1, `root files = ${vaultJson.files?.length}`);
assert(vaultJson.user.storageUsedBytes > 0, `usage = ${vaultJson.user.storageUsedBytes}`);
assert(vaultJson.folders.length === 1, "nested folder visible");

const insideFolder = await call(`/api/vault?folderId=${folderJson.folder.id}`);
const insideJson = await insideFolder.json();
assert(insideJson.files.length === 1, `folder files = ${insideJson.files.length}`);

// 7. range streaming
const downloadUrl = insideJson.files[0].downloadUrl;
const rangeRes = await fetch(BASE + downloadUrl, { headers: { range: "bytes=0-31" } });
assert(rangeRes.status === 206, `range request -> ${rangeRes.status}`);
assert(
  rangeRes.headers.get("content-range") === "bytes 0-31/128",
  `content-range = ${rangeRes.headers.get("content-range")}`,
);
const whole = await fetch(BASE + downloadUrl);
assert(whole.status === 200 && (await whole.arrayBuffer()).byteLength === 128, "full read");

// 8. favorite + rename + delete
const fileId = insideJson.files[0].id;
const fav = await call(`/api/files/${fileId}`, {
  method: "PATCH",
  body: JSON.stringify({ isFavorite: true, fileName: "renamed.txt" }),
});
assert(fav.ok, "patch file");
const favList = await call("/api/vault?favorites=1");
const favJson = await favList.json();
assert(favJson.files.length === 1 && favJson.files[0].fileName === "renamed.txt", "favorites filter");

const del = await call(`/api/files/${fileId}`, { method: "DELETE" });
assert(del.ok, "delete file");
const afterDelete = await call("/api/vault");
assert((await afterDelete.json()).user.storageUsedBytes < vaultJson.user.storageUsedBytes, "quota released");

// 9. vault lock
const lock = await call("/api/auth/lock", { method: "POST" });
const lockedListing = await call("/api/vault");
assert(lock.ok && lockedListing.status === 423, `locked vault -> ${lockedListing.status}`);

// 10. biometric round trip
const enroll = await call("/api/auth/biometric", {
  method: "POST",
  body: JSON.stringify({
    credentialId: "cred-12345678",
    publicKeyJwk: {
      kty: "EC",
      crv: "P-256",
      x: "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
      y: "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWl5MNDI5YU",
    },
  }),
});
assert(enroll.ok, `biometric enroll -> ${enroll.status}`);

// 11. refresh + logout
const refresh = await call("/api/auth/refresh", { method: "POST" });
assert(refresh.ok, `refresh -> ${refresh.status}`);
const logout = await call("/api/auth/logout", { method: "POST" });
assert(logout.ok, "logout");
const me = await call("/api/auth/me");
assert((await me.json()).user === null, "session cleared");

console.log("\nDone.");
