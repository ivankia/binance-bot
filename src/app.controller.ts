import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Response } from "express";
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('signal')
  public async signal(@Req() request: Request, @Res() response: Response) {
    this.appService.storeSignal(request.body);
    return response.status(HttpStatus.OK).json({
      'status': 'OK'
    });
  }

  @Post('close')
  public async close(@Req() request: Request, @Res() response: Response) {
    this.appService.closeAllPositions();
    return response.status(HttpStatus.OK).json({
      'status': 'OK'
    });
  }
}
