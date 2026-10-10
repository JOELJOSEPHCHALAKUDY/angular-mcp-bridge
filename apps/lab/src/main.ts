import { bootstrapApplication } from '@angular/platform-browser';
import { provideMcpBridge, provideLocalMcpModal } from '@angular-mcp-bridge/angular';
import { LabComponent } from './app.js';
bootstrapApplication(LabComponent, { providers: [provideMcpBridge({ name: 'angular-bridge-lab' }), provideLocalMcpModal()] }).catch(console.error);
