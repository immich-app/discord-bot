import { db } from '../db';

export const getSponsorLicenses = async (githubUsername: string) => {
  const sponsor = await db
    .selectFrom('sponsor')
    .selectAll()
    .where('username', '=', githubUsername)
    .executeTakeFirstOrThrow();

  if (!sponsor) {
    return [];
  }

  await db.updateTable('sponsor').set('claimed', true).where('username', '=', githubUsername).execute();

  return sponsor.licenses.map(({ activation, license }) => ({
    type: sponsor.licenseType,
    licenseKey: license,
    activationKey: activation,
  }));
};
