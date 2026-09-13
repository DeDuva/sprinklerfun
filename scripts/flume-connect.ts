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
 * ends up in Vercel is a credential that is scoped to API access, revocable on
 * its own, and worthless anywhere else.
 *
 * Nothing here is logged: not the password, not the access token, not the
 * refresh token beyond the single line you are meant to copy.
 */
import { createInterface } from "node:readline"
import { stdin, stdout } from "node:process"
import { exchangePassword } from "../lib/server/flume"

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()) }))
}

/**
 * Read a line without echoing it.
 *
 * readline offers no hidden-input mode, so the prompt is written once and the
 * terminal's own echo is muted for the duration — the standard approach, and
 * the reason this takes a few lines rather than one.
 */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(question)
    const rl = createInterface({ input: stdin, output: stdout, terminal: true })
    // @ts-expect-error _writeToOutput is internal, and is the only hook readline
    // gives for suppressing echo.
    rl._writeToOutput = () => {}
    rl.question("", (answer) => {
      rl.close()
      stdout.write("\n")
      resolve(answer.trim())
    })
  })
}

async function main() {
  console.log("\nConnect SprinklerFun to Flume\n")
  console.log("Your password is used once, here, to obtain a refresh token.")
  console.log("It is not saved, not sent anywhere except Flume, and not logged.\n")

  const clientId = process.env.FLUME_CLIENT_ID || (await ask("Flume client ID: "))
  const clientSecret = process.env.FLUME_CLIENT_SECRET || (await askHidden("Flume client secret: "))
  if (!clientId || !clientSecret) {
    throw new Error(
      "A client ID and secret are required. Request Personal API access at " +
        "https://portal.flumetech.com/#token"
    )
  }

  const username = await ask("Flume account email: ")
  const password = await askHidden("Flume account password: ")
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
}

main().catch((err) => {
  // Deliberately terse: an auth failure here should not echo back anything the
  // caller typed.
  console.error(`\nCould not connect: ${err instanceof Error ? err.message : String(err)}`)
  console.error("Check the client ID/secret at https://portal.flumetech.com/#token, ")
  console.error("and that the email and password are the ones you use in the Flume app.\n")
  process.exit(1)
})
