The `npm-publish` environment secret `NPM_TOKEN` is the only credential that can move a dist-tag. Trusted Publishing (OIDC) can publish and nothing else — `npm dist-tag add` answers E401 under it. When this token expires, publishing still works and **every production release from `main` stops at the promotion step**.

**Rotate**

1. npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**. Packages: `@rockhopper-co/mcp-server` only. Permission: Read and write. Expiration: 90 days.
2. Store it in **1Password**, vault `Rockhopper Engineering`, item title `NPM_TOKEN_MCP_SERVER`. Never paste the value into a shell, a file, or a chat.
3. **GitHub** → `Rockhopper-Co/mcp-server` → Settings → Environments → `npm-publish` → Environment secrets → `NPM_TOKEN` → update.
4. Edit the date on the last line of `.github/npm-token-expiry` to the new expiry and push. That is what closes this warning.
5. Prove it works, do not assume:
   ```
   gh workflow run publish.yml --ref dev -f verify_promotion_credential=true
   ```
   The probe adds and immediately removes a throwaway dist-tag and asserts `latest` and `staging` never moved.
6. Close this issue.

<sub>Opened automatically by `.github/workflows/npm-token-expiry.yml`. The date comes from `.github/npm-token-expiry`; this body comes from `.github/npm-token-expiry-issue.md`. Updated in place each week — it will not duplicate.</sub>
