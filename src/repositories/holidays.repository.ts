import { HolidayDto, IHolidaysInterface } from 'src/interfaces/holidays.interface';

export class HolidaysRepository implements IHolidaysInterface {
  async getHolidays(countryCode: string, year: number) {
    const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`);

    if (!response.ok) {
      throw new Error(`Could not fetch holidays: ${response.statusText}`);
    }

    return response.json() as Promise<HolidayDto[]>;
  }
}
