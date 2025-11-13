export const IHolidaysInterface = 'IHolidaysRepository';

export type HolidayType = 'Public' | 'Bank' | 'School' | 'Authorities' | 'Optional' | 'Observance';

export type HolidayDto = {
  date: string;
  localName: string | null;
  name: string | null;
  countryCode: string | null;
  global: boolean;
  counties: string[] | null;
  launchYear: number | null;
  types: HolidayType[] | null;
};

export interface IHolidaysInterface {
  getHolidays(countryCode: string, year: number): Promise<HolidayDto[]>;
}
