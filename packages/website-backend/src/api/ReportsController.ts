import { Controller, Get, Put, BodyParams, QueryParams, HeaderParams, Req } from '@tsed/common';
import { BadRequest, NotFound, Unauthorized, InternalServerError } from 'ts-httpexceptions';
import { MutationTestingReportMapper, MutationTestingReport, determineRepoSlugAndVersion, InvalidSlugError } from 'stryker-dashboard-data-access';
import DataAccess from '../services/DataAccess';
import { ReportValidator } from '../services/SchemaValidator';
import { calculateMetrics } from 'mutation-testing-metrics';
import Configuration from '../services/Configuration';
import { ApiKeyValidator } from '../services/ApiKeyValidator';
import { Request } from 'express';
import { Report } from 'stryker-dashboard-website-contract';

interface PutReportResponse {
  href: string;
}

const API_KEY_HEADER = 'X-Api-Key';

@Controller('/reports')
export default class ReportsController {

  private readonly repo: MutationTestingReportMapper;

  constructor(dataAccess: DataAccess,
              private readonly reportValidator: ReportValidator,
              private readonly config: Configuration,
              private readonly apiKeyValidator: ApiKeyValidator) {
    this.repo = dataAccess.mutationTestingReportMapper;
  }

  @Put('/*')
  public async update(
    @Req() req: Request,
    @BodyParams() reportData: Omit<Report, 'repositorySlug' | 'version' | 'module'>,
    @QueryParams('module') moduleName: string | undefined,
    @HeaderParams(API_KEY_HEADER) authorizationHeader: string | undefined,
  ): Promise<PutReportResponse> {
    if (!authorizationHeader) {
      throw new Unauthorized(`Provide an "${API_KEY_HEADER}" header`);
    }
    const slug = req.path;
    const { repositorySlug, version } = this.determineRepoSlugAndVersion(slug);
    await this.apiKeyValidator.validateApiKey(authorizationHeader, repositorySlug);
    this.verifyRequiredPutReportProperties(reportData);
    const report = {
      ...reportData,
      repositorySlug,
      version,
      moduleName
    };
    try {
      await this.saveReport(report);
      return {
        href: `${this.config.baseUrl}/reports/${repositorySlug}/${version}${moduleName ? `?module=${moduleName}` : ''}`
      };
    } catch (err) {
      console.error('Error while trying to save report', report, err);
      throw new InternalServerError('Internal server error');
    }
  }

  @Get('/*')
  public async get(
    @Req() req: Request,
    @QueryParams('module') moduleName: string | undefined
  ): Promise<Report> {
    const slug = req.path;
    const { repositorySlug, version } = this.determineRepoSlugAndVersion(slug);
    const result = await this.repo.findOne({
      repositorySlug,
      moduleName,
      version
    });
    if (result) {
      return ReportsController.toDto(result);
    } else {
      throw new NotFound(`Report "${repositorySlug}/${version}" does not exist`);
    }
  }

  public static toDto(dataObject: MutationTestingReport): Report {
    return {
      moduleName: dataObject.moduleName,
      repositorySlug: dataObject.repositorySlug,
      result: dataObject.result || undefined,
      version: dataObject.version,
      mutationScore: dataObject.mutationScore
    };
  }

  private determineRepoSlugAndVersion(slug: string) {
    try {
      return determineRepoSlugAndVersion(slug);
    } catch (error) {
      if (error instanceof InvalidSlugError) {
        throw new NotFound(`Invalid slug "${slug}"`);
      } else {
        throw error;
      }
    }
  }

  private async saveReport(report: Report) {
    const mutationScore = this.calculateMutationScore(report);
    await this.repo.insertOrMergeEntity({
      version: report.version,
      result: report.result || null,
      moduleName: report.moduleName,
      repositorySlug: report.repositorySlug,
      mutationScore
    });
  }
  private calculateMutationScore(report: Report) {
    if (report.result) {
      return calculateMetrics(report.result.files).metrics.mutationScore;
    } else {
      return report.mutationScore || 0;
    }
  }

  private verifyRequiredPutReportProperties(body: any) {
    if (body.result === undefined && body.mutationScore === undefined) {
      throw new BadRequest(`Missing required property "result" or "mutationScore"`);
    }
    if (body.result) {
      const errors = this.reportValidator.findErrors(body.result);
      if (errors) {
        throw new BadRequest(`Property "result" not valid. ${errors}`);
      }
    }
  }
}