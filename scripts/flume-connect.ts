/**
 * Mint a Flume refresh token, locally, once.
 *
 * Run with:  npm run flume:connect
 *
 * Why this exists
 * ---------------
 * Flume's API needs an account password for exactly one thing: the initial
 * OAuth2 password grant that produces a refresh token. Everything afterwards
 * uses grant_type=refresh_token with the client id and secret.
 *
 * So the password never needs to reach the deployment — and it doesn't. This
 * script runs on your machine, holds the password in memory for the length of
 * one HTTPS request, prints the refresh token, and writes nothing to disk. What
 * ends up in Vercel is a credential scoped to API access, revocable on its own,
 * and worthless anywhere else.
 *
 * Nothing here is logged: not the password, not the access token, not the
 * refresh token beyond the single line you are meant to copy.
 */
import { createInterface } from "node:readline"
import { stdin, stdout } from "node:process"
import { exchangePassword } from "../lib/server/flume"

/**
 * One readline interface for the whole run, with echo muted per question.
 *
 * The prompt string is handed to `rl.question()` rather than written first with
 * `stdout.write()`. That ordering is the entire bug this replaces: readline in
 * terminal mode redraws the current line when it takes over, emitting
 * `ESC[1G ESC[0J` — cursor to column one, clear to end of screen — which wiped
 * a prompt printed just before it. With echo also suppressed, the result was a
 * blank line that accepted typing invisibly and looked exactly like a hang.
 *
 * Muting is switched on only *after* `question()` has rendered its prompt, so
 * the prompt is visible and only the typed characters are hidden.
 */
function makePrompter() {
  const isTty = stdin.isTTY === true
  const rl = createInterface({ input: stdin, output: stdout, terminal: isTty })

  let muted = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = (rl as any)._writeToOutput?.bind(rl)
  if (original) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(rl as any)._writeToOutput = (s: string) => {
      if (!muted) original(s)
    }
  }

  return {
    ask: (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, (a) => resolve(a.trim()))),

    askHidden: (question: string): Promise<string> =>
      new Promise((resolve) => {
        // `(input hidden)` matters: without it a blank, unmoving line reads as
        // a crash rather than as a password field.
        rl.question(`${question} (input hidden) `, (a) => {
          muted = false
          if (isTty) stdout.write("\n")
          resolve(a.trim())
        })
        muted = true
      }),

    close: () => rl.close(),
  }
}

async function main() {
  const p = makePrompter()
  try {
    console.log("\nConnect SprinklerFun to Flume\n")
    console.log("Your password is used once, here, to obtain a refresh token.")
    console.log("It is not saved, not sent anywhere except Flume, and not logged.")
    console.log("Secrets are not echoed as you type — a blank line is expected.\n")

    const clientId = process.env.FLUME_CLIENT_ID || (await p.ask("Flume client ID: "))
    const clientSecret =
      process.env.FLUME_CLIENT_SECRET || (await p.askHidden("Flume client secret:"))
    if (!clientId || !clientSecret) {
      throw new Error(
        "A client ID and secret are required. Request Personal API access at " +
          "https://portal.flumetech.com/#token"
      )
    }

    const username = await p.ask("Flume account email: ")
    const password = await p.askHidden("Flume account password:")
    if (!username || !password) throw new Error("Email and password are both required.")

    console.log("\nAsking Flume for a token…")
    const tokens = await exchangePassword({ username, password, clientId, clientSecret })

    console.log("\n  Connected.\n")
    console.log("Set these, then redeploy:\n")
    console.log(`  FLUME_CLIENT_ID=${clientId}`)
    console.log("  FLUME_CLIENT_SECRET=<the secret you just entered>")
    console.log(`  FLUME_REFRESH_TOKEN=${tokens.refreshToken}\n`)
    console.log("For production:")
    console.log("  vercel env add FLUME_CLIENT_ID production")
    console.log("  vercel env add FLUME_CLIENT_SECRET production")
    console.log("  vercel env add FLUME_REFRESH_TOKEN production\n")
    console.log("The app stores the current refresh token in its database after the first")
    console.log("sync, so FLUME_REFRESH_TOKEN is only a seed. Your password is now done with.\n")
  } finally {
    // Always closed, including on the error path — otherwise a failed run would
    // leave the terminal in readline's raw mode.
    p.close()
  }
}

main().catch((err) => {
  // Deliberately terse: an auth failure here must not echo back anything the
  // caller typed.
  console.error(`\nCould not connect: ${err instanceof Error ? err.message : String(err)}`)
  console.error("Check the client ID/secret at https://portal.flumetech.com/#token, ")
  console.error("and that the email and password are the ones you use in the Flume app.\n")
  process.exit(1)
})
