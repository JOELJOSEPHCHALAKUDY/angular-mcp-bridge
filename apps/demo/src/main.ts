import { bootstrapApplication } from '@angular/platform-browser';
import { provideMcpBridge } from '@angular-mcp-bridge/angular';
import { DemoComponent } from './app.js';
bootstrapApplication(DemoComponent, { providers: [provideMcpBridge({ name: 'angular-project-view' })] }).catch(console.error);
