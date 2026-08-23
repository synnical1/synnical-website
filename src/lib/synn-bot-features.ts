import { readFile } from "fs/promises"
import path from "path"
import { db } from "./db"
import { parseDuration } from "./feature-platform"
import { canAccessPublicChannel } from "./channel-permissions"

export type BotFeatureContext = {
  userId: string
  username: string
  role: string
  channelId: string
}

type BotFeatureResult = { reply: string; createdPollId?: string } | null

function staff(role: string) { return ["OWNER", "HEAD_ADMIN", "ADMIN", "MOD"].includes(role) }
function admin(role: string) { return ["OWNER", "HEAD_ADMIN", "ADMIN"].includes(role) }
function clean(value: string, max = 1000) { return value.trim().slice(0, max) }

function weatherDescription(code: number): string {
  if (code === 0) return "Clear sky"
  if ([1, 2, 3].includes(code)) return "Partly cloudy"
  if ([45, 48].includes(code)) return "Fog"
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle"
  if ([61, 63, 65, 66, 67].includes(code)) return "Rain"
  if ([71, 73, 75, 77].includes(code)) return "Snow"
  if ([80, 81, 82].includes(code)) return "Rain showers"
  if ([85, 86].includes(code)) return "Snow showers"
  if ([95, 96, 99].includes(code)) return "Thunderstorm"
  return `Weather code ${code}`
}

async function weather(place: string): Promise<string> {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(8000) })
  if (!geo.ok) throw new Error(`geocoding HTTP ${geo.status}`)
  const g = await geo.json() as any
  const hit = g?.results?.[0]
  if (!hit) return `I couldn't find a weather location matching **${place}**.`
  const forecast = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto`, { signal: AbortSignal.timeout(8000) })
  if (!forecast.ok) throw new Error(`forecast HTTP ${forecast.status}`)
  const body = await forecast.json() as any
  const c = body?.current
  if (!c) return `Weather data is temporarily unavailable for **${hit.name}**.`
  const area = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ")
  return `Weather for **${area}**: ${weatherDescription(Number(c.weather_code))}, **${c.temperature_2m}°C** (feels ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h, precipitation ${c.precipitation} mm.`
}

async function defineWord(word: string): Promise<string> {
  const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(8000) })
  if (response.status === 404) return `I couldn't find an English dictionary entry for **${word}**.`
  if (!response.ok) throw new Error(`dictionary HTTP ${response.status}`)
  const body = await response.json() as any[]
  const entry = body?.[0]
  const meanings = Array.isArray(entry?.meanings) ? entry.meanings.slice(0, 3) : []
  const lines = meanings.flatMap((meaning: any) => (meaning.definitions || []).slice(0, 2).map((definition: any) => `- **${meaning.partOfSpeech || "definition"}:** ${definition.definition}`)).slice(0, 5)
  return lines.length ? `**${entry.word || word}** ${entry.phonetic ? `(${entry.phonetic})` : ""}\n${lines.join("\n")}` : `I found **${word}**, but the API returned no usable definition.`
}

const UNIT_FACTORS: Record<string, { family: string; toBase: (v: number) => number; fromBase: (v: number) => number }> = {
  m: { family: "length", toBase: v => v, fromBase: v => v }, meter: { family: "length", toBase: v => v, fromBase: v => v }, meters: { family: "length", toBase: v => v, fromBase: v => v },
  km: { family: "length", toBase: v => v * 1000, fromBase: v => v / 1000 },
  cm: { family: "length", toBase: v => v / 100, fromBase: v => v * 100 },
  mm: { family: "length", toBase: v => v / 1000, fromBase: v => v * 1000 },
  mi: { family: "length", toBase: v => v * 1609.344, fromBase: v => v / 1609.344 }, mile: { family: "length", toBase: v => v * 1609.344, fromBase: v => v / 1609.344 }, miles: { family: "length", toBase: v => v * 1609.344, fromBase: v => v / 1609.344 },
  ft: { family: "length", toBase: v => v * 0.3048, fromBase: v => v / 0.3048 },
  in: { family: "length", toBase: v => v * 0.0254, fromBase: v => v / 0.0254 },
  kg: { family: "mass", toBase: v => v, fromBase: v => v },
  g: { family: "mass", toBase: v => v / 1000, fromBase: v => v * 1000 },
  lb: { family: "mass", toBase: v => v * 0.45359237, fromBase: v => v / 0.45359237 }, lbs: { family: "mass", toBase: v => v * 0.45359237, fromBase: v => v / 0.45359237 },
  oz: { family: "mass", toBase: v => v * 0.028349523125, fromBase: v => v / 0.028349523125 },
  ml: { family: "volume", toBase: v => v, fromBase: v => v },
  l: { family: "volume", toBase: v => v * 1000, fromBase: v => v / 1000 },
  cup: { family: "volume", toBase: v => v * 236.5882365, fromBase: v => v / 236.5882365 }, cups: { family: "volume", toBase: v => v * 236.5882365, fromBase: v => v / 236.5882365 },
}

function convertUnits(args: string): string {
  const temp = args.match(/^(-?\d+(?:\.\d+)?)\s*(c|f)\s+(?:to|in)\s+(c|f)$/i)
  if (temp) {
    const value = Number(temp[1]); const from = temp[2].toLowerCase(); const to = temp[3].toLowerCase()
    const result = from === to ? value : from === "c" ? value * 9 / 5 + 32 : (value - 32) * 5 / 9
    return `${value}°${from.toUpperCase()} = **${Number(result.toFixed(4))}°${to.toUpperCase()}**`
  }
  const match = args.match(/^(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:to|in)\s+([a-z]+)$/i)
  if (!match) return "Use `/convert 5 km to mi`, `/convert 7 cups to ml`, or `/convert 20 c to f`."
  const value = Number(match[1]); const fromKey = match[2].toLowerCase(); const toKey = match[3].toLowerCase()
  const from = UNIT_FACTORS[fromKey]; const to = UNIT_FACTORS[toKey]
  if (!from || !to || from.family !== to.family) return "Those units are not in the same supported conversion family."
  const result = to.fromBase(from.toBase(value))
  return `${value} ${fromKey} = **${Number(result.toFixed(6))} ${toKey}**`
}

async function currency(args: string): Promise<string> {
  const match = args.match(/^(\d+(?:\.\d+)?)\s+([a-z]{3})\s+(?:to|in)\s+([a-z]{3})$/i)
  if (!match) return "Use `/currency 10 GBP to USD`."
  const amount = Number(match[1]); const from = match[2].toUpperCase(); const to = match[3].toUpperCase()
  if (from === to) return `${amount} ${from} = **${amount} ${to}**`
  const response = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) return `I couldn't get a current ${from}/${to} rate.`
  const body = await response.json() as any
  const rate = Number(body?.rate)
  if (!Number.isFinite(rate)) return `The currency service returned an invalid ${from}/${to} rate.`
  return `${amount} ${from} ≈ **${Number((amount * rate).toFixed(4))} ${to}** at ${rate} ${to}/${from} (${body.date || "latest"}).`
}

function makeTeams(args: string): string {
  const parts = args.split("|").map(x => x.trim()).filter(Boolean)
  const count = Math.max(2, Math.min(16, Number(parts.shift()) || 2))
  if (parts.length < count) return "Use `/teams 2 | Alex | Sam | Jo | Kai`."
  const shuffled = [...parts].sort(() => Math.random() - 0.5)
  const teams = Array.from({ length: count }, () => [] as string[])
  shuffled.forEach((name, index) => teams[index % count].push(name))
  return teams.map((team, index) => `**Team ${index + 1}:** ${team.join(", ")}`).join("\n")
}

function bracket(args: string): string {
  const names = args.split("|").map(x => x.trim()).filter(Boolean).slice(0, 32).sort(() => Math.random() - 0.5)
  if (names.length < 2) return "Use `/bracket Alex | Sam | Jo | Kai`."
  const lines: string[] = ["**Round 1 bracket**"]
  for (let i = 0; i < names.length; i += 2) lines.push(`${Math.floor(i / 2) + 1}. ${names[i]} vs ${names[i + 1] || "BYE"}`)
  return lines.join("\n")
}

async function canSeeChannel(channel: any, userId: string, role: string) {
  if (channel.isDM || channel.isGroup) return Boolean(await db.membership.findFirst({ where: { channelId: channel.id, userId }, select: { id: true } }))
  return canAccessPublicChannel(channel.allowedRoles, role)
}

export async function runSynnBotFeature(input: string, ctx: BotFeatureContext): Promise<BotFeatureResult> {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const firstSpace = trimmed.indexOf(" ")
  const command = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase()
  const args = clean(firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1), 4000)

  // Staff-created commands are checked after built-ins, so an owner cannot
  // silently shadow a safety or platform command.
  const builtin = new Set(["customcmd","delcmd","remind","poll","countdown","weather","define","convert","currency","teams","bracket","findmsg","modsummary","profile","game","botstats"])
  if (!builtin.has(command)) {
    const custom = await db.botCustomCommand.findUnique({ where: { name: command } }).catch(() => null)
    if (custom?.enabled) return { reply: custom.response }
    return null
  }

  if (command === "customcmd") {
    if (!admin(ctx.role)) return { reply: "Only admins can create Synn Bot custom commands." }
    const [nameRaw, ...responseParts] = args.split("|")
    const name = (nameRaw || "").trim().replace(/^\//, "").toLowerCase()
    const response = responseParts.join("|").trim().slice(0, 2000)
    if (!/^[a-z0-9_-]{2,32}$/.test(name) || !response) return { reply: "Use `/customcmd command-name | response text`." }
    if (builtin.has(name)) return { reply: "That name is reserved by a built-in Synn Bot command." }
    await db.botCustomCommand.upsert({ where: { name }, update: { response, enabled: true, createdById: ctx.userId }, create: { name, response, createdById: ctx.userId } })
    return { reply: `Custom command **/${name}** is now active.` }
  }

  if (command === "delcmd") {
    if (!admin(ctx.role)) return { reply: "Only admins can delete Synn Bot custom commands." }
    const name = args.replace(/^\//, "").toLowerCase()
    const result = await db.botCustomCommand.deleteMany({ where: { name } })
    return { reply: result.count ? `Deleted custom command **/${name}**.` : `No custom command named **/${name}** exists.` }
  }

  if (command === "remind" || command === "countdown") {
    const [durationRaw, ...bodyParts] = args.split(/\s+/)
    const ms = parseDuration(durationRaw || "")
    const body = clean(bodyParts.join(" "), 1000)
    if (!ms || !body) return { reply: `Use \`/${command} 30m ${command === "remind" ? "message" : "label"}\`.` }
    const dueAt = new Date(Date.now() + ms)
    await db.botReminder.create({ data: { userId: ctx.userId, channelId: ctx.channelId, kind: command === "countdown" ? "countdown" : "reminder", body, dueAt } })
    return { reply: `${command === "countdown" ? "Countdown" : "Reminder"} set for **${dueAt.toLocaleString("en-GB", { timeZone: "UTC" })} UTC**.` }
  }

  if (command === "poll") {
    const parts = args.split("|").map(x => x.trim()).filter(Boolean)
    const question = parts.shift() || ""
    if (!question || parts.length < 2) return { reply: "Use `/poll Question | Choice A | Choice B`." }
    const poll = await db.poll.create({ data: { channelId: ctx.channelId, question: question.slice(0, 300), createdById: ctx.userId } })
    await db.pollOption.createMany({ data: parts.slice(0, 10).map((label, position) => ({ pollId: poll.id, label: label.slice(0, 120), position })) })
    return { reply: `Poll created: **${question}**\n${parts.slice(0, 10).map((label, i) => `${i + 1}. ${label}`).join("\n")}\nOpen the channel Polls tool to vote.`, createdPollId: poll.id }
  }

  if (command === "weather") return { reply: args ? await weather(args) : "Use `/weather London`." }
  if (command === "define") return { reply: args ? await defineWord(args.split(/\s+/)[0]) : "Use `/define word`." }
  if (command === "convert") return { reply: convertUnits(args) }
  if (command === "currency") return { reply: await currency(args) }
  if (command === "teams") return { reply: makeTeams(args) }
  if (command === "bracket") return { reply: bracket(args) }

  if (command === "findmsg") {
    if (!args) return { reply: "Use `/findmsg words to search`." }
    const channels = await db.channel.findMany()
    const allowed: string[] = []
    for (const channel of channels) if (await canSeeChannel(channel, ctx.userId, ctx.role)) allowed.push(channel.id)
    const messages = await db.message.findMany({ where: { channelId: { in: allowed }, deleted: false, content: { contains: args.slice(0, 200) } }, orderBy: { createdAt: "desc" }, take: 8 })
    return { reply: messages.length ? `Found ${messages.length} recent match(es):\n${messages.map(m => `- **${m.username}:** ${m.content.slice(0, 180)}`).join("\n")}` : "No matching messages were found in channels you can access." }
  }

  if (command === "modsummary") {
    if (!staff(ctx.role)) return { reply: "Moderation summaries are staff-only." }
    const targetName = args.replace(/^@/, "").toLowerCase()
    const target = targetName ? await db.user.findUnique({ where: { username: targetName } }) : await db.user.findUnique({ where: { id: ctx.userId } })
    if (!target) return { reply: "User not found." }
    const infractions = await db.infraction.findMany({ where: { userId: target.id }, orderBy: { createdAt: "desc" }, take: 20 })
    const reports = await db.report.count({ where: { targetUserIdSnapshot: target.id, status: "OPEN" } })
    return { reply: `**Moderation summary for @${target.username}**\nRole: ${target.role}\nWarnings: ${target.warnCount}\nOpen reports: ${reports}\nRecent infractions: ${infractions.length ? infractions.map(i => `${i.type}: ${i.reason}`).join("; ").slice(0, 1000) : "none"}` }
  }

  if (command === "profile") {
    const username = args.replace(/^@/, "").toLowerCase()
    if (!username) return { reply: "Use `/profile username`." }
    const user = await db.user.findUnique({ where: { username } })
    if (!user) return { reply: "User not found." }
    const friends = await db.friendship.count({ where: { status: "ACCEPTED", OR: [{ requesterId: user.id }, { receiverId: user.id }] } })
    const progress = await db.userProgress.findUnique({ where: { userId: user.id } })
    return { reply: `**${user.displayName}** (@${user.username}) · ${user.role}\n${user.bio || "No bio"}\nMessages: ${user.messageCount} · Friends: ${friends} · Level: ${progress?.level || 1}${user.gameStatus ? `\nPlaying: ${user.gameStatus}` : ""}` }
  }

  if (command === "game") {
    if (!args) return { reply: "Use `/game title`." }
    try {
      const raw = await readFile(path.join(process.cwd(), "stratus", "cloud.json"), "utf8")
      const data = JSON.parse(raw)
      const list = Array.isArray(data) ? data : Array.isArray(data?.games) ? data.games : []
      const q = args.toLowerCase()
      const matches = list.filter((game: any) => String(game.name || game.title || "").toLowerCase().includes(q)).slice(0, 8)
      return { reply: matches.length ? `Games matching **${args}**:\n${matches.map((game: any) => `- ${game.name || game.title}`).join("\n")}` : `No packaged game matches **${args}**.` }
    } catch { return { reply: "The game catalog is temporarily unavailable." } }
  }

  if (command === "botstats") {
    const grouped = await db.botUsage.groupBy({ by: ["command"], _count: { command: true }, orderBy: { _count: { command: "desc" } }, take: 10 })
    const total = await db.botUsage.count()
    return { reply: `Synn Bot has handled **${total}** tracked feature-command requests.\n${grouped.map((row, index) => `${index + 1}. /${row.command}: ${row._count.command}`).join("\n") || "No tracked feature commands yet."}` }
  }

  return null
}
