import { decode } from 'html-entities';
import fetch from 'node-fetch';

import { TranslationService, TranslationResult } from '.';
import {
  replaceInterpolations,
  reInsertInterpolations,
  Matcher,
} from '../matchers';

const API_ENDPOINT = 'https://api.deepl.com/v2';

export class DeepL implements TranslationService {
  public name = 'DeepL';
  private apiKey: string;
  private supportedLanguages: Set<string>;
  private formalityLanguages: Set<string>;
  private interpolationMatcher: Matcher;
  private decodeEscapes: boolean;
  private formality: 'default' | 'less' | 'more';

  async initialize(
    config?: string,
    interpolationMatcher?: Matcher,
    decodeEscapes?: boolean,
  ) {
    if (!config) {
      throw new Error(`Please provide an API key for DeepL.`);
    }
    const [apiKey, formality] = config.split(',');
    this.apiKey = apiKey;
    this.formality =
      formality === 'less' || formality === 'more' ? formality : 'default';
    this.interpolationMatcher = interpolationMatcher;
    const languages = await this.fetchLanguages();
    this.supportedLanguages = this.formatLanguages(languages);
    this.formalityLanguages = this.getFormalityLanguages(languages);
    this.decodeEscapes = decodeEscapes;
  }

  async fetchLanguages() {
    const url = new URL(`${API_ENDPOINT}/languages`);
    url.searchParams.append('auth_key', this.apiKey);
    url.searchParams.append('type', 'target');

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error('Could not fetch supported languages from DeepL');
    }

    const languages: Array<{
      language: string;
      name: string;
      supports_formality: boolean;
    }> = await response.json();
    return languages;
  }

  getFormalityLanguages(languages: Array<{ language: string, name: string, supports_formality: boolean}>) {
    const supportedLangauges = languages.filter((l) => l.supports_formality);
    return this.formatLanguages(supportedLangauges);
  }

  formatLanguages(languages: Array<{ language: string, name: string, supports_formality: boolean}>) {
    // DeepL supports e.g. either EN-US or EN as language code, but only returns EN-US
    // so we add both variants to the array and filter duplicates later.
    const languageCodes = languages.flatMap((l) => [
      l.language,
      l.language.split('-')[0],
    ]);
    return new Set(languageCodes.map((l) => l.toLowerCase()));
  }

  supportsLanguage(language: string) {
    return this.supportedLanguages.has(language.toLowerCase());
  }

  supportsFormality(language: string) {
    return this.formalityLanguages.has(language.toLowerCase());
  }

  async translateStrings(
    strings: { key: string; value: string }[],
    from: string,
    to: string,
  ) {
    return Promise.all(
      strings.map((string) => this.translateString(string, from, to)),
    );
  }

  async translateString(
    string: { key: string; value: string },
    from: string,
    to: string,
    triesLeft: number = 5,
  ): Promise<TranslationResult> {
    const { clean, replacements } = replaceInterpolations(
      string.value,
      this.interpolationMatcher,
    );

    const url = new URL(`${API_ENDPOINT}/translate`);
    url.searchParams.append('text', clean);
    url.searchParams.append('source_lang', from.toUpperCase());
    url.searchParams.append('target_lang', to.toUpperCase());
    url.searchParams.append('auth_key', this.apiKey);
    url.searchParams.append('auth_key', this.apiKey);
    if (this.supportsFormality(to)) {
      //only append formality to avoid bad request error from deepl for languages with unsupported formality
      url.searchParams.append('formality', this.formality);
    }

    const response = await fetch(String(url));

    if (!response.ok) {
      if (response.status === 429 && triesLeft > 0) {
        return this.translateString(string, from, to, triesLeft - 1);
      }

      throw new Error(
        `[${response.status} ${response.statusText}]: ${
          (await response.text()) || 'Empty body'
        }`,
      );
    }

    const translated = reInsertInterpolations(
      (await response.json()).translations[0].text,
      replacements,
    );

    return {
      key: string.key,
      value: string.value,
      translated: this.decodeEscapes ? decode(translated) : translated,
    };
  }
}
