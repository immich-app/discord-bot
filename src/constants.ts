export enum DiscordModal {
  Env = 'envModal',
  Logs = 'logsModal',
  Compose = 'composeModal',
  Message = 'messageModal',
}

export enum DiscordButton {
  Submit = 'submit',
  OpenTicket = 'openTicket',
}

export enum DiscordField {
  Env = 'env',
  Logs = 'logs',
  Source = 'source',
  Name = 'name',
  Message = 'message',
}

export enum GithubRepo {
  Immich = 'immich',
  StaticPages = 'static-pages',
}

export enum GithubOrg {
  ImmichApp = 'immich-app',
}

export const IMMICH_REPOSITORY_BASE_OPTIONS = { owner: 'immich-app', repo: 'immich' };

const docs = {
  Backup: 'https://immich.app/docs/administration/backup-and-restore',
  CLI: 'https://immich.app/docs/features/command-line-interface',
  Containers: 'https://immich.app/docs/guides/docker-help#containers',
  Docker: 'https://immich.app/docs/guides/docker-help',
  FAQ: 'https://immich.app/docs/FAQ',
  Libraries: 'https://immich.app/docs/features/libraries',
  Logs: 'https://immich.app/docs/guides/docker-help#logs',
  Queries: 'https://immich.app/docs/guides/database-queries',
  ReverseProxy: 'https://immich.app/docs/administration/reverse-proxy',
  Sidecar: 'https://immich.app/docs/features/xmp-sidecars',
  Upgrade: 'https://immich.app/docs/install/docker-compose#step-4---upgrading',
};

const icons = {
  Checked: ':ballot_box_with_check:',
  Immich: '<:immich:1216750773598294066>',
  Unchecked: ':blue_square:',
};

const urls = {
  FeatureRequest: 'https://github.com/immich-app/immich/discussions/new?category=feature-request',
  GitHub: 'https://github.com',
  GitHubRepoApi: 'https://api.github.com/repos/immich-app/immich',
  GoogleTakeOut: 'https://github.com/immich-app/immich/discussions/1340',
  Immich: 'https://immich.app',
  ImmichRepo: 'https://github.com/immich-app/immich',
  Issues: 'https://github.com/immich-app/immich/issues',
  MyImmich: 'https://my.immich.app',
  Release:
    'https://github.com/immich-app/immich/discussions?discussions_q=label%3Achangelog%3Abreaking-change+sort%3Adate_created',
  Formatting:
    'https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline#h_01GY0DAKGXDEHE263BCAYEGFJA',
  Outline: 'https://outline.immich.cloud',
};

const discordTags = {
  Question: '1049704189686730823',
  Ready: '1166852154292699207',
  Setup: '1049704231692677120',
  Usage: '1049704247517794315',
};

const discordRoles = {
  Contributor: '980972470964215870',
  SupportCrew: '1184258769312551053',
};

const discordChannels = {
  DevFocusTopic: '1045707766754451486',
  TeamFocusTopic: '1330248543721754746',
};

const outlineCollections = {
  Dev: '0b0dee90-b10e-416a-9059-ad0a061326b6',
  Team: '943c8f09-b8e7-4891-beb0-e3346ac22609',
};

const outlineDocuments = {
  DevFocusTopic: 'dbe1d7d2-ca67-42a2-adb2-43496cb048b7',
  TeamFocusTopic: '7fbd54e9-7f6f-44e5-9ed0-05a12e35937e',
};

export const Constants = {
  Urls: {
    Docs: docs,
    ...urls,
  },
  Icons: icons,
  Discord: {
    Roles: discordRoles,
    Channels: discordChannels,
    Tags: discordTags,
  },
  Cron: {
    ImmichBirthday: '36 4 3 2 *',
    DailyReport: '0 12 * * *',
    WeeklyReport: '0 12 * * 4',
    MonthlyReport: '0 12 19 * *',
  },
  Outline: {
    Collections: outlineCollections,
    Documents: outlineDocuments,
  },
  Zulip: {
    Streams: { Immich: 54 },
    Topics: { ImmichRelease: 'release' },
  },
};

export const ReleaseMessages = [
  'A day with a release is a good day!',
  'New release, new possibilities!',
  "It's release day! Say hello to the latest version of Immich.",
  '🎉 Release time! 🚀',
  'Time to update! Immich just got better.',
  'Immich vX.Y is live!',
  "Our new release is here, and it's worth the wait.",
  "Out of the oven, fresh and new: Immich's latest release.",
  'Break out the confetti — Immich has released a new version!',
  'Guess what? New release, same awesomeness!',
  "Ready to upgrade? Immich's latest version just dropped.",
  'Release alert! Immich has leveled up.',
  "🚨 Breaking news: We found bugs, squashed them, and now they're an endangered species. New release out!",
  "We released a new version! It's like the last one but with fewer mistakes.",
  "Guess who's back? Back again. Immich's back. Tell a friend.",
  "If this release were a pizza, it'd have extra cheese, no bugs, and a side of perfection. 🍕",
  "New release? You bet! And no, we didn't just hit CTRL+C, CTRL+V this time!",
  'We released a new version! The bugs cried, the features cheered, and the code sighed in relief.',
  "New Immich version out! It's like the old version, but with 100% more awesome.",
  'We released so much cool stuff, our code is wearing sunglasses now. 😎',
  'Immich release: because you deserve better, and our code needed therapy.',
  'This release is smoother than your morning coffee — without the jitters! ☕',
  'Our latest release is like a cat — it fixed bugs and then knocked everything else off the table. 🐱',
  "We found bugs. We squashed them. Then we found more. It's an endless cycle, but here's the latest release!",
  "New release dropping like it's hot — because it is! 🔥",
  "Released: A version so fresh, even the bugs didn't see it coming.",
  'Update your Immich before the bugs start planning their revenge.',
  'New Immich release: like finding a $20 bill in your old jacket.',
  'We fixed the bugs, upgraded the features, and now the code is doing a happy dance.',
  "It's release day! Prepare for fewer bugs and more hugs. 🤗",
  'The new Immich release is so good, even our test scripts are celebrating. 🎉',
  "We just released the new version! You'll feel like a coding superhero with these features. 🦸",
  'New release: Now with extra polish, like the fancy shoes you wear once a year.',
  "Forget the gym — we've been squashing bugs for cardio. New release out now!",
  "New version out! We're officially better at fixing bugs than your morning alarm is at waking you up.",
  'Our code had a glow-up! Check out the newest version of Immich. ✨',
  "Introducing the new release: It's like a magic trick, but instead of a rabbit, we pulled out new features. 🎩",
  "The new Immich release is here, and it's cooler than a penguin in sunglasses. 🐧😎",
  "New release alert! We found bugs, called in the exterminators, and now it's clean code paradise.",
  "This release is so smooth, we're thinking of entering it into the Winter Olympics. ⛷️",
  'The new version is here — just in time to rescue your project from whatever “version X” was doing.',
  'New Immich release: now with 75% more feature magic and 100% fewer “oops” moments.',
  'Code ninjas at work! Bugs have been stealthily eliminated in this release. 🥷',
  "Our new release is out, and let's just say: our code is finally having a good hair day.",
  'Immich release day: More fixes than a coffee addict in a caffeine shop. ☕',
  'New release: Now with 50% more code confidence and 100% fewer error messages.',
  "Our latest release is like a fine wine: it took some time, but it's finally perfect! 🍷",
  "Our new release is live! It's so optimized, even your grandma's computer will run it.",
  'Update or be left behind... with all the bugs. 🐛',
  'New Immich release: because who needs sleep when you have flawless code?',
  'Introducing the new version, powered by coffee and the fear of deadlines.',
  'Release day: where bugs go to disappear and features come to life.',
  'Our latest release is the code equivalent of a spa day — fresh, clean, and relaxed.',
  'New release is here, no cap! Unless you left Caps Lock on. Then, maybe.',
  'This release is like a hug from a cat — unexpected but very welcome. 🐾',
  'Just dropped a new release! Now featuring 100% fewer excuses.',
  'Get ready for the smoothest Immich release yet — like butter on a hot pancake. 🥞',
  "Release day! We promise it's better than that thing you forgot in the microwave.",
  'New release: Now with 50% more “wow” and 100% less “huh?”.',
  "The code is so clean now, you could eat off it. But please don't.",
  "Version upgrade! Because “Ctrl+Alt+Delete” shouldn't be your default solution.",
  "We've leveled up! This new release is practically a cheat code.",
  "Immich update: the only time you'll actually enjoy being bugged for an update.",
  'New release is here! Our code finally stopped rebelling.',
  'We tried to add a dancing unicorn, but settled for bug fixes instead. 🦄',
  'Guess what? The new release is shinier than a freshly polished keyboard.',
  'New release: like a fine cup of coffee, but for your code.',
  "Immich update: It's like getting a surprise pizza, but digital.",
  'Our latest version is out! Cleaner code, happier developers.',
  'Bug fixes were hard, but we made it look easy. New release is here!',
  "Releasing the latest version: It's sleeker than your favorite pair of sneakers.",
  'This release is so good, we almost threw a party. 🎉',
  "New Immich release: Because you deserve software that doesn't make you cry.",
  'Release day: We put the bugs on notice and shipped greatness.',
  "This release is smoother than that cool breeze you're wishing for.",
  'New version alert: Ready to make your life 42% better. 📈',
  'Immich release: where coding mistakes go to retire.',
  'Update now! Our bugs are out of a job.',
  'New version out! Now with 100% more stability and 200% more awesome.',
  'We released so many features, we forgot to count.',
  'Latest release: all the bug fixes, none of the headaches.',
  "It's release time! Your code just became 10x cooler.",
  'Immich update: fresh as a morning breeze (but no alarms required).',
  'Our latest release is cooler than a cucumber. 🥒',
  'Upgrade now! We fixed all the things, and maybe added a few surprises.',
  'New release: Because bug-free is the way to be.',
  "Brace yourself! The new version of Immich is here, and it's magnificent.",
  'Release day: Code so clean, even Marie Kondo approves.',
  'Our latest release is hotter than your favorite meme right now.',
  "Goodbye bugs, hello perfection! Immich's new release is live.",
  'The only thing more exciting than this release? Your reaction when you see it.',
  "The new version is out! You didn't know you needed it, but trust us — you do.",
  'Immich release: Your code will thank you later.',
  'New version out! Even the bugs are scared to come back.',
  "Our code just went from 'meh' to 'heck yeah!' with this release.",
  'Release day: Just click update and let the magic happen.',
  "Update time! New version, same awesome you've come to expect.",
  "Immich just released a new version, and trust us — it's worth a celebration!",
];
