import { db } from '../db';

export const getSponsorLicenses = async (githubUsername: string) => {
  const sponsor = await db
    .selectFrom('sponsor')
    .selectAll()
    .where('username', '=', githubUsername)
    .executeTakeFirstOrThrow();

  if (!sponsor) {
    return null;
  }
  await db.updateTable('sponsor').set('claimed', true).where('username', '=', githubUsername).execute();
  return {
    username: sponsor.username,
    total: sponsor.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
    licenseType: sponsor.licenseType,
    licenses: sponsor.licenses,
  };
};
