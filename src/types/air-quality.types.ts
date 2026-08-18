import { AirQualityPayloadError } from '../errors/AirQualityPayloadError';

type JsonRecord = Record<string, unknown>;

export interface AirQualityFeedMessage extends JsonRecord {
  aqi: number;
  idx: number;
  xsync: AirQualityFeedSync;
}

export interface AirQualityFeedSync extends JsonRecord {
  gen: number;
}

export interface AirQualityFeedObservation extends JsonRecord {
  msg: AirQualityFeedMessage;
}

export interface AirQualityFeedResponse extends JsonRecord {
  rxs: JsonRecord & {
    obs: AirQualityFeedObservation[];
  };
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseAirQualityFeedResponse = (payload: unknown): AirQualityFeedResponse => {
  if (!isRecord(payload)) {
    throw new AirQualityPayloadError('The AQI response must be an object');
  }

  const rxs = payload.rxs;

  if (!isRecord(rxs)) {
    throw new AirQualityPayloadError('The AQI response does not contain an rxs object');
  }

  const observations = rxs.obs;

  if (!Array.isArray(observations) || observations.length === 0) {
    throw new AirQualityPayloadError('The AQI response does not contain observations');
  }

  const observation: unknown = observations[0];

  if (!isRecord(observation)) {
    throw new AirQualityPayloadError('The AQI response contains an invalid observation');
  }

  const message = observation.msg;

  if (
    !isRecord(message) ||
    typeof message.aqi !== 'number' ||
    typeof message.idx !== 'number' ||
    !isRecord(message.xsync) ||
    typeof message.xsync.gen !== 'number'
  ) {
    throw new AirQualityPayloadError('The AQI response does not contain valid AQI data');
  }

  return payload as AirQualityFeedResponse;
};
