import { Controller, Get } from '@nestjs/common';

@Controller()
export class HelloController {
  @Get('hello')
  getHello() {
    return { message: 'Hello World' };
  }
}

