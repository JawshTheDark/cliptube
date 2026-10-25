# Clip Tools and Games

- [Clip a moment](#clip-a-moment)
- [GIF and MP4 export](#gif-and-mp4-export)
- [Looping links](#looping-links)
- [Compare](#compare)
- [Games](#games)
- [The network's game catalog](#the-networks-game-catalog)
- [Game artwork from SteamGridDB](#game-artwork-from-steamgriddb)

## Clip a moment

The **Clip** button on a watch page (and *Make a clip* in the timeline editor) cuts a range of a video into a
new video that links back to where it came from. It starts with the 30 seconds before the playhead.

- **Exact** starts precisely where you chose (re-encoded).
- **Fast** starts at the nearest keyframe before it and copies without re-encoding, so it keeps full quality and
  is ready almost at once.

You can always clip your own videos. Tick *Let others clip this video* on a video so viewers can make their own
clips of it.

## GIF and MP4 export

The same dialog exports a range as a download:

- a palette-optimised **GIF** of up to 15 seconds, or
- a 720p **MP4** of up to 60 seconds, with or without sound.

Exports are kept for a day.

## Looping links

Share → *Loop a range* makes a link such as `/watch/abc?t=12&end=20` that plays just that part, over and over.
Good for showing off one play.

## Compare

The compare button on a watch page opens `/compare` with that clip on one side. Pick the other clip, line up
the same moment with each side's start buttons (down to a single frame), then play both on one transport bar
at up to 1/10 speed. *Copy link* shares the lined-up comparison.

## Games

Moderators keep the game list in **Admin → Games**:

| Field | Example | Used for |
| --- | --- | --- |
| Name | `Call of Duty: Modern Warfare III` | Shown everywhere |
| Short name | `MW3` | Matching in the Game field, and on game cards without a cover |
| Also known as | `cod, call of duty` | Other spellings, so a clip tagged with any of them on another server lands on the same game here |

Uploads and video details have a **Game** field. Each game has a page at `/g/<id>` with its clips (newest, most
viewed or top rated) and its own feed (`/feeds/game/<id>.atom`), and **Games** in the sidebar lists them all.
The game travels with the video across the network.

## The network's game catalog

In a network, the **hub keeps the catalog**:

- members get the hub's games automatically, with their artwork, so nobody has to build their own list;
- when the hub changes a game, members follow; when it deletes one, it disappears from every member's list
  (the clips stay, without a game);
- members can still add games of their own;
- the hub's games are locked on members (*The hub keeps this game up to date; it is changed or deleted there*).

## Game artwork from SteamGridDB

[SteamGridDB](https://www.steamgriddb.com) is a community collection of game artwork. With an API key, ClipTube
uses it for three kinds of images:

| Kind | Where it shows | What is kept here |
| --- | --- | --- |
| **Cover** | Game cards and the game page | 600×900 JPEG |
| **Title logo** | Across the game page's banner | Transparent PNG, up to 800 px wide |
| **Banner** | Behind the game page's header | JPEG, up to 1920 px wide |

**Setting it up**

1. Sign in at steamgriddb.com and copy your API key from its Preferences, under API.
2. Paste it in **Admin → Games → SteamGridDB**. The key is write-only: the page only says whether one is set.
   From the command line:

   ```bash
   docker exec -i cliptube node server/cli.js settings set-secret steamgriddb_api_key < keyfile
   ```

3. Leave **Fill in artwork for new games** on, and click **Fill in missing artwork** once for the games you
   already have.

**How it picks**

New games are looked up by name. A result with the same name wins, ignoring case, punctuation and accents
(so *Call of Duty Black Ops 7* finds *Call of Duty: Black Ops 7*); otherwise the first verified result is used.
Then SteamGridDB's best-rated cover, logo and banner are copied here. Images flagged as NSFW, humor or
epilepsy-unsafe are never offered.

**Choosing other images**

Each game's **Artwork** button opens a picker: search SteamGridDB, choose the right game, switch between
*Cover*, *Title logo* and *Banner*, and click an image to use it.

**Credits**

Each image's artist is credited on the game's page (*Artwork from SteamGridDB by …*). The images are copies on
your server, so pages don't depend on SteamGridDB being up.

**In a network** only the hub needs a key: members show the hub's artwork for the hub's games. A member with
its own key can fetch artwork for the games it added itself.
